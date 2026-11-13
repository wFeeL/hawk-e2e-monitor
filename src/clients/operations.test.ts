import { readFileSync } from 'node:fs';
import { buildSchema, parse, validate } from 'graphql';
import type { OperationDefinitionNode } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckError } from '../errors/taxonomy.js';
import type { CheckError, ErrorClass } from '../errors/taxonomy.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeApiError, FakeHawk } from '../test-support/fake-hawk/index.js';
import { systemClock } from '../time/clock.js';
import { GraphqlFailure, createGraphqlTransport } from './graphql.js';
import type { GraphqlOperation, GraphqlTransport } from './graphql.js';
import { ALL_OPERATIONS, EVENT_CARD, FIND_EVENTS, LOGIN, PROJECT_TOKEN, REFRESH_TOKENS, REMOVE_EVENT, WORKSPACE_QUOTA } from './operations.js';

const FIXTURE = new URL('../../test/fixtures/hawk-api.graphql', import.meta.url);
const OPERATION_COUNT = 7;

/** What the Login mutation returns inside `data`. */
interface LoginData {
  /** Issued tokens. */
  login: TokenPair;
}

/** Tokens in the `Login` answer. */
interface TokenPair {
  /** Access token. */
  accessToken: string;
}

/** Data of `ProjectToken`. */
interface ProjectData {
  /** The project. */
  project: ProjectTokenValue;
}

/** Token of a project. */
interface ProjectTokenValue {
  /** Integration token. */
  token: string;
}

let hawk: FakeHawk;
let signal: AbortSignal;

/**
 * Builds a transport for the fake API.
 * @param url API address.
 * @returns Transport with 1 ms retry delays.
 */
function transportFor(url = hawk.api.url): GraphqlTransport {
  return createGraphqlTransport({ url,
    httpTimeoutMs: 1000,
    clock: systemClock,
    retryDelaysMs: [1, 1] });
}

/**
 * Builds the `errors` knob for one operation.
 * @param operation Operation name.
 * @param code `extensions.code`.
 * @param message Error message.
 * @returns Value for `knobs.errors`.
 */
function injected(operation: string, code: string, message: string): Record<string, FakeApiError> {
  return Object.fromEntries([[operation, { code,
    message }]]);
}

/**
 * Runs a request and returns the error it throws.
 * @param promise Request promise.
 * @returns The thrown error.
 */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected the request to fail');
}

/**
 * Expects a CheckError of a class.
 * @param error Thrown value.
 * @param errorClass Expected class.
 * @returns The same error, typed.
 */
function checkError(error: unknown, errorClass: ErrorClass): CheckError {
  if (!isCheckError(error)) {
    throw new Error(`Expected CheckError, got ${String(error)}`);
  }

  expect(error.errorClass).toBe(errorClass);

  return error;
}

/**
 * Logs in through the transport.
 * @param transport Transport to use.
 * @returns Access token.
 */
async function login(transport: GraphqlTransport): Promise<string> {
  const data = await transport.request<LoginData>(
    LOGIN, { email: hawk.email,
      password: hawk.password }, undefined, signal);

  return data.login.accessToken;
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  signal = new AbortController().signal;
});

afterEach(async () => {
  await hawk.close();
});

describe('operations', () => {
  const schema = buildSchema(readFileSync(FIXTURE, 'utf8'));

  it('lists all seven operations', () => {
    expect(ALL_OPERATIONS).toHaveLength(OPERATION_COUNT);
    expect(ALL_OPERATIONS).toEqual([LOGIN, REFRESH_TOKENS, PROJECT_TOKEN, WORKSPACE_QUOTA, FIND_EVENTS, EVENT_CARD, REMOVE_EVENT]);
  });

  it.each(ALL_OPERATIONS.map(operation => [operation.name, operation] as const))(
    'every operation validates against the Hawk schema fixture: %s',
    (_name, operation) => {
      const document = parse(operation.document);
      const definition = document.definitions[0] as OperationDefinitionNode;

      expect(validate(schema, document)).toEqual([]);
      expect(document.definitions).toHaveLength(1);
      expect(definition.name?.value).toBe(operation.name);
    }
  );

  it('a typo is caught', () => {
    const typo = PROJECT_TOKEN.document.replace('token', 'toke');
    const errors = validate(schema, parse(typo));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('toke');
  });

  it('only RemoveEvent and RefreshTokens are not idempotent', () => {
    expect(ALL_OPERATIONS.filter(operation => !operation.idempotent).map(operation => operation.name))
      .toEqual(['RefreshTokens', 'RemoveEvent']);
  });
});

describe('graphql transport', () => {
  it('returns data and sends the bearer token', async () => {
    const transport = transportFor();
    const token = await login(transport);
    const data = await transport.request<ProjectData>(
      PROJECT_TOKEN, { projectId: hawk.projectId }, token, signal);

    expect(data.project.token).toBe(hawk.token);
  });

  it('down is api_unavailable', async () => {
    hawk.api.knobs.down = true;

    const error = checkError(await failureOf(transportFor().request(PROJECT_TOKEN, { projectId: hawk.projectId }, 'x', signal)), 'api_unavailable');

    expect(error.facts.status).toBe(503);
    expect(hawk.api.operations).toEqual(['ProjectToken', 'ProjectToken', 'ProjectToken']);
  });

  it('refused connection is api_unavailable', async () => {
    const url = hawk.api.url;

    await hawk.close();
    checkError(await failureOf(transportFor(url).request(PROJECT_TOKEN, { projectId: hawk.projectId }, 'x', signal)), 'api_unavailable');
    hawk = await startFakeHawk();
  });

  it('non-JSON answer is api_unavailable', async () => {
    const url = hawk.api.url.replace('/graphql', '/other');

    checkError(await failureOf(transportFor(url).request(LOGIN, { email: 'a',
      password: 'b' }, undefined, signal)), 'api_unavailable');
  });

  it('unknown operation is api_query_rejected', async () => {
    const unknown: GraphqlOperation = { name: 'Nope',
      document: 'query Nope { x }',
      idempotent: true };

    checkError(await failureOf(transportFor().request(unknown, {}, undefined, signal)), 'api_query_rejected');
  });

  it('FORBIDDEN is api_forbidden', async () => {
    const token = await login(transportFor());
    const error = checkError(await failureOf(transportFor().request(PROJECT_TOKEN, { projectId: 'c'.repeat(24) }, token, signal)), 'api_forbidden');

    expect(error.facts.projectId).toBe('c'.repeat(24));
  });

  it('GRAPHQL_VALIDATION_FAILED and BAD_USER_INPUT are api_query_rejected', async () => {
    for (const code of ['GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT']) {
      hawk.api.knobs.errors = injected('Login', code, 'bad');
      checkError(await failureOf(transportFor().request(LOGIN, { email: 'a',
        password: 'b' }, undefined, signal)), 'api_query_rejected');
    }
  });

  it('INTERNAL_SERVER_ERROR is api_error', async () => {
    hawk.api.knobs.errors = injected('EventCard', 'INTERNAL_SERVER_ERROR', 'boom');

    const token = await login(transportFor());
    const error = checkError(await failureOf(transportFor().request(EVENT_CARD, { projectId: hawk.projectId,
      eventId: 'a'.repeat(24) }, token, signal)), 'api_error');

    expect(error.facts.detail).toBe('boom');
  });

  it.each(['UNAUTHENTICATED', 'ACCESS_TOKEN_EXPIRED_ERROR', 'SSO_REQUIRED'])('%s is GraphqlFailure', async (code) => {
    hawk.api.knobs.errors = injected('Login', code, 'nope');

    const error = await failureOf(transportFor().request(LOGIN, { email: 'a',
      password: 'b' }, undefined, signal));

    expect(error).toBeInstanceOf(GraphqlFailure);
    expect(error).toMatchObject({ code,
      message: 'nope',
      name: 'GraphqlFailure' });
  });

  it('expired token is GraphqlFailure', async () => {
    const transport = transportFor();
    const token = await login(transport);

    hawk.api.knobs.expireAccessOnce = true;

    const error = await failureOf(transport.request(PROJECT_TOKEN, { projectId: hawk.projectId }, token, signal));

    expect(error).toBeInstanceOf(GraphqlFailure);
    expect(error).toMatchObject({ code: 'ACCESS_TOKEN_EXPIRED_ERROR' });
  });

  it('200 without errors and without data is api_error', async () => {
    const url = hawk.api.url;
    const real = globalThis.fetch;

    globalThis.fetch = () => Promise.resolve(new Response('{}'));

    try {
      checkError(await failureOf(transportFor(url).request(LOGIN, {}, undefined, signal)), 'api_error');
    } finally {
      globalThis.fetch = real;
    }
  });

  it('idempotent query is retried on 503, mutation is not', async () => {
    const transport = createGraphqlTransport({ url: hawk.api.url,
      httpTimeoutMs: 1000,
      clock: systemClock,
      retryDelaysMs: [200] });
    const token = await login(transport);

    hawk.api.knobs.downForMs = 150;
    hawk.api.operations.length = 0;

    const data = await transport.request<ProjectData>(PROJECT_TOKEN, { projectId: hawk.projectId }, token, signal);

    expect(data.project.token).toBe(hawk.token);
    expect(hawk.api.operations).toEqual(['ProjectToken', 'ProjectToken']);

    hawk.api.knobs.downForMs = 151;
    hawk.api.operations.length = 0;

    checkError(await failureOf(transport.request(REMOVE_EVENT, { projectId: hawk.projectId,
      eventId: 'a'.repeat(24) }, token, signal)), 'api_unavailable');
    expect(hawk.api.operations).toEqual(['RemoveEvent']);
  });
});
