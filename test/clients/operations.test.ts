import { readFileSync } from 'node:fs';
import { Kind, buildSchema, parse, validate } from 'graphql';
import type { OperationDefinitionNode } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckError } from '../../src/errors/taxonomy.js';
import type { CheckError, ErrorClass } from '../../src/errors/taxonomy.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeApiError, FakeHawk } from '../support/fake-hawk/index.js';
import { systemClock } from '../../src/time/clock.js';
import { GraphqlFailure, createGraphqlTransport } from '../../src/clients/graphql.js';
import type { GraphqlOperation, GraphqlTransport } from '../../src/clients/graphql.js';
import { ALL_OPERATIONS, CREATE_NOTIFICATION_RULE, CREATE_PROJECT, REMOVE_PROJECT, WORKSPACE_PROJECTS, DELETE_NOTIFICATION_RULE, EVENT, PROJECT_DAILY_EVENTS, LOGIN, NOTIFICATION_RULES, PROJECT_TOKEN, REFRESH_TOKENS, REMOVE_EVENT, UPDATE_NOTIFICATION_RULE, WORKSPACE_QUOTA } from '../../src/clients/operations.js';

const FIXTURE = new URL('../fixtures/hawk-api.graphql', import.meta.url);
const OPERATION_COUNT = 14;

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
    retry: { attempts: 3,
      delaysMs: [1, 1] } });
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

  it('lists all the operations', () => {
    expect(ALL_OPERATIONS).toHaveLength(OPERATION_COUNT);
    expect(ALL_OPERATIONS).toEqual([LOGIN, REFRESH_TOKENS, PROJECT_TOKEN, WORKSPACE_QUOTA, PROJECT_DAILY_EVENTS, EVENT, REMOVE_EVENT, NOTIFICATION_RULES, CREATE_NOTIFICATION_RULE, UPDATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE, CREATE_PROJECT, REMOVE_PROJECT, WORKSPACE_PROJECTS]);
  });

  it.each(ALL_OPERATIONS.map(operation => [operation.name, operation] as const))(
    'every operation validates against the Hawk schema fixture: %s',
    (_name, operation) => {
      const document = parse(operation.document);
      const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);

      expect(validate(schema, document)).toEqual([]);
      expect(operations).toHaveLength(1);
      expect(operations[0]?.name?.value).toBe(operation.name);
    }
  );

  it('reads events with the documents of Garage, fragment included', () => {
    for (const operation of [PROJECT_DAILY_EVENTS, EVENT]) {
      expect(operation.document).toContain('fragment Event on Event');
      expect(operation.document).toContain('fragment eventBacktrace on EventBacktraceFrame');
      expect(operation.document).toContain('...Event');
      expect(operation.idempotent).toBe(true);
    }

    expect(parse(EVENT.document).definitions.filter(definition => definition.kind === Kind.FRAGMENT_DEFINITION)).toHaveLength(3);
    expect(EVENT.document).toContain('query Event($projectId: ID!, $eventId: ID!, $originalEventId: ID!)');
    expect(PROJECT_DAILY_EVENTS.document).toContain('dailyEventsPortion(sort: $sort, filters: $filters, search: $search, release: $release, assignee: $assignee, nextCursor: $cursor)');
  });

  it('a typo is caught', () => {
    const typo = PROJECT_TOKEN.document.replace('token', 'toke');
    const errors = validate(schema, parse(typo));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('toke');
  });

  it('only the operations that change something and cannot be repeated blindly are not idempotent', () => {
    expect(ALL_OPERATIONS.filter(operation => !operation.idempotent).map(operation => operation.name))
      .toEqual(['RefreshTokens', 'RemoveEvent', 'CreateNotificationRule', 'CreateProject', 'RemoveProject']);
    expect(WORKSPACE_PROJECTS.idempotent).toBe(true);
  });

  it('CreateNotificationRule is not idempotent', () => {
    expect(CREATE_NOTIFICATION_RULE.idempotent).toBe(false);
    expect([NOTIFICATION_RULES, UPDATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE].every(operation => operation.idempotent)).toBe(true);
  });

  it('a typo in NotificationRules is caught', () => {
    const typo = NOTIFICATION_RULES.document.replace('whatToReceive', 'whatToReceiv');
    const errors = validate(schema, parse(typo));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('whatToReceiv');
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

  it('INTERNAL_SERVER_ERROR is api_error on an operation of the monitor', async () => {
    hawk.api.knobs.errors = injected('RemoveEvent', 'INTERNAL_SERVER_ERROR', 'boom');

    const token = await login(transportFor());
    const error = checkError(await failureOf(transportFor().request(REMOVE_EVENT, { projectId: hawk.projectId,
      eventId: 'a'.repeat(24) }, token, signal)), 'api_error');

    expect(error.facts.detail).toBe('boom');
  });

  it.each([EVENT, PROJECT_DAILY_EVENTS])('errors[] on the Garage document $name is api_garage_query_failed', async (operation) => {
    const token = await login(transportFor());

    for (const code of ['INTERNAL_SERVER_ERROR', 'BAD_USER_INPUT', 'GRAPHQL_VALIDATION_FAILED']) {
      hawk.api.knobs.errors = injected(operation.name, code, 'boom');

      const error = checkError(await failureOf(transportFor().request(operation, { projectId: hawk.projectId,
        eventId: 'a'.repeat(24),
        originalEventId: 'a'.repeat(24),
        search: 'x' }, token, signal)), 'api_garage_query_failed');

      expect(error.facts.detail).toBe('boom');
      expect(error.culprit).toBe('hawk');
    }
  });

  it('errors[] on a Garage document answered with HTTP 400 is read as errors[]', async () => {
    const token = await login(transportFor());

    hawk.api.knobs.errors = Object.fromEntries([['Event', { code: 'GRAPHQL_VALIDATION_FAILED',
      message: 'Cannot query field "x" on type "Event".',
      status: 400 }]]);

    const error = checkError(await failureOf(transportFor().request(EVENT, { projectId: hawk.projectId,
      eventId: 'a'.repeat(24),
      originalEventId: 'a'.repeat(24) }, token, signal)), 'api_garage_query_failed');

    expect(error.facts).toMatchObject({ status: 400,
      detail: 'Cannot query field "x" on type "Event".' });
  });

  it('HTTP 400 on an operation of the monitor stays api_query_rejected', async () => {
    hawk.api.knobs.errors = Object.fromEntries([['ProjectToken', { code: 'GRAPHQL_VALIDATION_FAILED',
      message: 'bad',
      status: 400 }]]);

    checkError(await failureOf(transportFor().request(PROJECT_TOKEN, { projectId: hawk.projectId }, 'x', signal)), 'api_query_rejected');
  });

  it('FORBIDDEN and the sign-in codes keep their own path on a Garage document', async () => {
    const token = await login(transportFor());

    checkError(await failureOf(transportFor().request(EVENT, { projectId: 'c'.repeat(24),
      eventId: 'a'.repeat(24),
      originalEventId: 'a'.repeat(24) }, token, signal)), 'api_forbidden');

    hawk.api.knobs.errors = injected('Event', 'UNAUTHENTICATED', 'nope');

    expect(await failureOf(transportFor().request(EVENT, { projectId: hawk.projectId,
      eventId: 'a'.repeat(24),
      originalEventId: 'a'.repeat(24) }, token, signal))).toBeInstanceOf(GraphqlFailure);
  });

  it('only the two Garage documents carry the garage flag', () => {
    expect(ALL_OPERATIONS.filter(operation => operation.garage === true)).toEqual([PROJECT_DAILY_EVENTS, EVENT]);
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

  it('uses the configured number of attempts', async () => {
    const transport = createGraphqlTransport({ url: hawk.api.url,
      httpTimeoutMs: 1000,
      clock: systemClock,
      retry: { attempts: 2,
        delaysMs: [1] } });
    const token = await login(transport);

    hawk.api.knobs.down = true;
    hawk.api.operations.length = 0;

    checkError(await failureOf(transport.request(PROJECT_TOKEN, { projectId: hawk.projectId }, token, signal)), 'api_unavailable');
    expect(hawk.api.operations).toEqual(['ProjectToken', 'ProjectToken']);
  });

  it('idempotent query is retried on 503, mutation is not', async () => {
    const transport = createGraphqlTransport({ url: hawk.api.url,
      httpTimeoutMs: 1000,
      clock: systemClock,
      retry: { attempts: 3,
        delaysMs: [200] } });
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
