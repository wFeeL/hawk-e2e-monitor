import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckError } from '../errors/taxonomy.js';
import type { CheckError } from '../errors/taxonomy.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeApiError, FakeHawk } from '../test-support/fake-hawk/index.js';
import { systemClock } from '../time/clock.js';
import { createGraphqlTransport } from './graphql.js';
import { createHawkApi } from './hawk-api.js';
import type { HawkApi } from './hawk-api.js';

let hawk: FakeHawk;
let signal: AbortSignal;

/**
 * Builds a client for the running fake.
 * @param password Account password, the right one by default.
 * @returns Client with 1 ms retry delays.
 */
function apiFor(password = hawk.password): HawkApi {
  return createHawkApi({ transport: createGraphqlTransport({ url: hawk.api.url,
    httpTimeoutMs: 1000,
    clock: systemClock,
    retryDelaysMs: [1, 1] }),
  email: hawk.email,
  password,
  clock: systemClock,
  retryDelaysMs: [1] });
}

/**
 * Builds the `errors` knob for one operation.
 * @param operation Operation name.
 * @param code `extensions.code`.
 * @param message Error message.
 * @param times How many requests get the error.
 * @returns Value for `knobs.errors`.
 */
function injected(operation: string, code: string, message: string, times?: number): Record<string, FakeApiError> {
  return Object.fromEntries([[operation, times === undefined
    ? { code,
        message }
    : { code,
        message,
        times }]]);
}

/**
 * Runs a call and returns the taxonomy error it throws.
 * @param promise Call promise.
 * @returns The thrown CheckError.
 */
async function checkErrorOf(promise: Promise<unknown>): Promise<CheckError> {
  try {
    await promise;
  } catch (error) {
    if (isCheckError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected the call to fail');
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  signal = new AbortController().signal;
});

afterEach(async () => {
  await hawk.close();
});

describe('hawk api session', () => {
  it('logs in once and reuses the token', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    await api.ensureSession(signal);
    await api.projectToken(hawk.projectId, signal);

    expect(hawk.api.operations.filter(name => name === 'Login')).toHaveLength(1);
  });

  it('projectToken returns the project token', async () => {
    expect(await apiFor().projectToken(hawk.projectId, signal)).toBe(hawk.token);
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken']);
  });

  it('wrong password is api_auth_failed', async () => {
    const error = await checkErrorOf(apiFor('wrong').ensureSession(signal));

    expect(error.errorClass).toBe('api_auth_failed');
    expect(error.facts.detail).toBe('Wrong email or password');
    expect(hawk.api.operations).toEqual(['Login']);
  });

  it('SSO_REQUIRED is api_auth_failed', async () => {
    hawk.api.knobs.errors = injected('Login', 'SSO_REQUIRED', 'SSO is required');

    expect((await checkErrorOf(apiFor().ensureSession(signal))).errorClass).toBe('api_auth_failed');
  });

  it('login argument validation is api_auth_failed', async () => {
    hawk.api.knobs.errors = injected('Login', 'BAD_USER_INPUT', 'Wrong email format');

    const error = await checkErrorOf(apiFor().ensureSession(signal));

    expect(error.errorClass).toBe('api_auth_failed');
    expect(error.facts.detail).toBe('Wrong email format');
  });

  it('unavailable API during login keeps its class', async () => {
    hawk.api.knobs.down = true;

    expect((await checkErrorOf(apiFor().ensureSession(signal))).errorClass).toBe('api_unavailable');
  });

  it('expired access token is refreshed once', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.expireAccessOnce = true;

    expect(await api.projectToken(hawk.projectId, signal)).toBe(hawk.token);
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken', 'RefreshTokens', 'ProjectToken']);
  });

  it('failed refresh falls back to login', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.expireAccessOnce = true;
    hawk.api.knobs.errors = injected('RefreshTokens', 'UNAUTHENTICATED', 'Invalid refresh token');

    expect(await api.projectToken(hawk.projectId, signal)).toBe(hawk.token);
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken', 'RefreshTokens', 'Login', 'ProjectToken']);
  });

  it('unavailable API during refresh is not turned into a login', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.expireAccessOnce = true;
    hawk.api.knobs.errors = injected('RefreshTokens', 'INTERNAL_SERVER_ERROR', 'boom');

    expect((await checkErrorOf(api.projectToken(hawk.projectId, signal))).errorClass).toBe('api_error');
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken', 'RefreshTokens']);
  });

  it('unauthenticated triggers one re-login', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.errors = injected('ProjectToken', 'UNAUTHENTICATED', 'You must be signed in to view this resource.', 1);

    expect(await api.projectToken(hawk.projectId, signal)).toBe(hawk.token);
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken', 'Login', 'ProjectToken']);
  });

  it('second auth failure is api_auth_failed', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.errors = injected('ProjectToken', 'UNAUTHENTICATED', 'You must be signed in to view this resource.');

    const error = await checkErrorOf(api.projectToken(hawk.projectId, signal));

    expect(error.errorClass).toBe('api_auth_failed');
    expect(hawk.api.operations).toEqual(['Login', 'ProjectToken', 'Login', 'ProjectToken']);
  });

  it('expired token again after re-login is api_auth_failed without a second refresh', async () => {
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.errors = injected('ProjectToken', 'ACCESS_TOKEN_EXPIRED_ERROR', 'You need to refresh your tokens');

    expect((await checkErrorOf(api.projectToken(hawk.projectId, signal))).errorClass).toBe('api_auth_failed');
    expect(hawk.api.operations.filter(name => name === 'RefreshTokens')).toHaveLength(1);
  });

  it('logs in by itself when there is no session', async () => {
    expect(await apiFor().projectToken(hawk.projectId, signal)).toBe(hawk.token);
    expect(hawk.api.operations[0]).toBe('Login');
  });

  it('other errors pass through unchanged', async () => {
    const error = await checkErrorOf(apiFor().projectToken('c'.repeat(24), signal));

    expect(error.errorClass).toBe('api_forbidden');
  });
});
