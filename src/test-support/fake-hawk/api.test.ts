import { afterEach, describe, expect, it } from 'vitest';
import { startFakeApi } from './api.js';
import type { FakeApi } from './api.js';
import { fakeHawkEnv, startFakeHawk } from './index.js';
import { createFakeStore } from './store.js';
import type { FakeStore } from './store.js';

const PROJECT = 'd'.repeat(24);
const EMAIL = 'monitor@example.com';
const PASSWORD = 'secret-pass';
const TOKEN = 'integration-token';
const FORBIDDEN_MESSAGE = 'You have no access to this workspace';

/** Fake API with its store. */
interface Harness {
  /** Running API. */
  api: FakeApi;
  /** Store behind it. */
  store: FakeStore;
}

/** Event as selected by the client queries. */
interface EventShape {
  /** Event or repetition id. */
  id: string;
  /** Id of the original event. */
  originalEventId: string;
  /** Group hash. */
  groupHash: string;
  /** Occurrences. */
  totalCount: number;
  /** Catcher type. */
  catcherType: string;
  /** Title and context. */
  payload: EventPayloadShape;
}

/** Selected `payload` of an event. */
interface EventPayloadShape {
  /** Title. */
  title: string;
  /** Context object. */
  context: Record<string, unknown>;
}

/** Selected `plan`. */
interface PlanShape {
  /** Events limit. */
  eventsLimit: number;
}

/** Workspace as selected by `WorkspaceQuota`. */
interface WorkspaceShape {
  /** Workspace id. */
  id: string;
  /** Blocked flag. */
  isBlocked: boolean;
  /** Counter, null for a fresh workspace. */
  billingPeriodEventsCount: number | null;
  /** Plan or null. */
  plan: PlanShape | null;
  /** Projects of the requested ids. */
  projects: Array<Record<'id', string>>;
}

/** One row of `dailyEvents`. */
interface DailyEventShape {
  /** Row id. */
  id: string;
  /** Occurrences. */
  count: number;
  /** Event with the latest repetition id. */
  event: EventShape;
}

/** Selections under `project`. */
interface ProjectShape {
  /** Integration token. */
  token: string;
  /** Event card or null. */
  event: EventShape | null;
  /** Search results. */
  dailyEventsPortion: Record<'dailyEvents', DailyEventShape[]>;
}

/** GraphQL `data` with every field the fake can return. */
interface DataShape {
  /** `Login` result. */
  login: Session;
  /** `RefreshTokens` result. */
  refreshTokens: Session;
  /** Project selections. */
  project: ProjectShape;
  /** `WorkspaceQuota` result. */
  workspaces: WorkspaceShape[];
  /** `RemoveEvent` result. */
  removeEvent: boolean;
}

/** GraphQL error entry. */
interface ErrorShape {
  /** Message. */
  message: string;
  /** Extensions with the code. */
  extensions: ExtensionsShape;
}

/** Error `extensions`. */
interface ExtensionsShape {
  /** Error code. */
  code: string;
}

/** GraphQL response body. */
interface BodyShape {
  /** Data or null. */
  data?: DataShape | null;
  /** Errors, if any. */
  errors?: ErrorShape[];
}

/** Parsed GraphQL answer. */
interface Answer {
  /** HTTP status. */
  status: number;
  /** Content-Type header. */
  type: string | null;
  /** Body parsed as JSON when possible, else the text. */
  body: BodyShape;
  /** Raw text. */
  text: string;
}

/** Access and refresh tokens from `Login`. */
interface Session {
  /** Access token. */
  accessToken: string;
  /** Refresh token. */
  refreshToken: string;
}

const apis: FakeApi[] = [];

/**
 * Starts an API over a fresh store; closed in afterEach.
 * @returns API and store.
 */
async function start(): Promise<Harness> {
  const store = createFakeStore();
  const api = await startFakeApi({ store,
    projectId: PROJECT,
    email: EMAIL,
    password: PASSWORD,
    token: TOKEN });

  apis.push(api);

  return { api,
    store };
}

/**
 * Sends one GraphQL request.
 * @param api Target API.
 * @param operationName Operation name, omitted when undefined.
 * @param variables Operation variables.
 * @param accessToken Bearer token, if any.
 * @returns Parsed answer.
 */
async function gql(api: FakeApi, operationName: string | undefined, variables: Record<string, unknown> = {}, accessToken?: string): Promise<Answer> {
  const headers = new Headers();

  headers.set('content-type', 'application/json');

  if (accessToken !== undefined) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(api.url, { method: 'POST',
    headers,
    body: JSON.stringify({ operationName,
      query: 'ignored',
      variables }) });
  const text = await response.text();
  let body: Answer['body'] = {};

  try {
    body = JSON.parse(text) as Answer['body'];
  } catch {
    // Not JSON, the text is enough.
  }

  return { status: response.status,
    type: response.headers.get('content-type'),
    body,
    text };
}

/**
 * Logs in with the valid account.
 * @param api Target API.
 * @returns Issued tokens.
 */
async function login(api: FakeApi): Promise<Session> {
  const answer = await gql(api, 'Login', { email: EMAIL,
    password: PASSWORD });

  return answer.body.data?.login as Session;
}

/**
 * Reads `data` of an answer that must have it.
 * @param answer Parsed answer.
 * @returns The data object.
 */
function dataOf(answer: Answer): DataShape {
  if (!answer.body.data) {
    throw new Error(`Expected data, got ${answer.text}`);
  }

  return answer.body.data;
}

/**
 * Reads the first error of an answer that must have one.
 * @param answer Parsed answer.
 * @returns The first error.
 */
function errorOf(answer: Answer): ErrorShape {
  const [error] = answer.body.errors ?? [];

  if (!error) {
    throw new Error(`Expected an error, got ${answer.text}`);
  }

  return error;
}

/**
 * Reads the single element of a list.
 * @param items List expected to be non-empty.
 * @returns The first element.
 */
function head<T>(items: readonly T[]): T {
  const [item] = items;

  if (item === undefined) {
    throw new Error('Expected a non-empty list');
  }

  return item;
}

afterEach(async () => {
  await Promise.all(apis.splice(0).map(async api => api.close()));
});

describe('fake api Login and RefreshTokens', () => {
  it('Login returns tokens', async () => {
    const { api } = await start();
    const answer = await gql(api, 'Login', { email: EMAIL,
      password: PASSWORD });

    expect(answer.status).toBe(200);
    expect(answer.type).toContain('application/json');
    expect(dataOf(answer).login.accessToken).toMatch(/^[0-9a-f]+$/u);
    expect(dataOf(answer).login.refreshToken).toMatch(/^[0-9a-f]+$/u);
  });

  it('Login with a wrong password is UNAUTHENTICATED', async () => {
    const { api } = await start();
    const answer = await gql(api, 'Login', { email: EMAIL,
      password: 'nope' });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ data: null,
      errors: [{ message: 'Wrong email or password',
        extensions: { code: 'UNAUTHENTICATED' } }] });
  });

  it('RefreshTokens rotates the pair and rejects the old refresh token', async () => {
    const { api } = await start();
    const session = await login(api);
    const refreshed = await gql(api, 'RefreshTokens', { refreshToken: session.refreshToken });
    const again = await gql(api, 'RefreshTokens', { refreshToken: session.refreshToken });

    expect(dataOf(refreshed).refreshTokens.accessToken).not.toBe(session.accessToken);
    expect(errorOf(again)).toEqual({ message: 'Invalid refresh token',
      extensions: { code: 'UNAUTHENTICATED' } });
  });
});

describe('fake api project operations', () => {
  it('ProjectToken returns the token or the knob value', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    expect((await gql(api, 'ProjectToken', { projectId: PROJECT }, accessToken)).body).toEqual({ data: { project: { token: TOKEN } } });

    api.knobs.projectToken = 'someone-elses';

    expect(dataOf(await gql(api, 'ProjectToken', { projectId: PROJECT }, accessToken)).project.token).toBe('someone-elses');
  });

  it('WorkspaceQuota lists a foreign empty workspace first and ours second', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const { workspaces } = dataOf(await gql(api, 'WorkspaceQuota', { projectId: PROJECT }, accessToken));

    expect(workspaces).toHaveLength(2);
    expect(head(workspaces).projects).toEqual([]);
    expect(workspaces[1]).toMatchObject({ isBlocked: false,
      billingPeriodEventsCount: 0,
      plan: { eventsLimit: 10_000 },
      projects: [{ id: PROJECT }] });
  });

  it('WorkspaceQuota follows the workspace knob, including plan null', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    api.knobs.workspace = { isBlocked: true,
      eventsLimit: 5,
      billingPeriodEventsCount: null };

    const blocked = dataOf(await gql(api, 'WorkspaceQuota', { projectId: PROJECT }, accessToken)).workspaces[1];

    expect(blocked).toMatchObject({ isBlocked: true,
      billingPeriodEventsCount: null,
      plan: { eventsLimit: 5 } });

    api.knobs.workspace = { isBlocked: false,
      eventsLimit: 5,
      billingPeriodEventsCount: 1,
      plan: null };

    expect(dataOf(await gql(api, 'WorkspaceQuota', { projectId: PROJECT }, accessToken)).workspaces[1]?.plan).toBeNull();
  });

  it('WorkspaceQuota for a foreign project returns empty projects, not FORBIDDEN', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const { workspaces } = dataOf(await gql(api, 'WorkspaceQuota', { projectId: 'e'.repeat(24) }, accessToken));

    expect(workspaces.map(workspace => workspace.projects)).toEqual([[], []]);
  });

  it('FindEvents returns the original id in originalEventId and the repetition id in event.id', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);
    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'run abc',
      context: { runId: 'abc' } });
    const found = async (): Promise<DailyEventShape[]> => dataOf(await gql(api, 'FindEvents', { projectId: PROJECT,
      search: 'abc' }, accessToken)).project.dailyEventsPortion.dailyEvents;

    expect(head(await found())).toMatchObject({ id: first.id,
      count: 1,
      event: { id: first.id,
        originalEventId: first.id,
        totalCount: 1,
        catcherType: 'errors/nodejs',
        payload: { title: 'run abc',
          context: { runId: 'abc' } } } });

    store.ingest(PROJECT, 'errors/nodejs', { title: 'run abc',
      context: { runId: 'abc' } });

    const rows = await found();

    expect(rows).toHaveLength(1);
    expect(head(rows).event).toMatchObject({ id: first.lastRepetitionId,
      originalEventId: first.id,
      totalCount: 2 });
    expect(head(rows).count).toBe(2);
  });

  it('foreignEvent adds one row with the runId in its title and no prefix', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);

    api.knobs.foreignEvent = true;

    const rows = dataOf(await gql(api, 'FindEvents', { projectId: PROJECT,
      search: 'rzzz' }, accessToken)).project.dailyEventsPortion.dailyEvents;

    expect(rows).toHaveLength(1);
    expect(head(rows).event.payload).toEqual({ title: 'foreign rzzz',
      context: {} });
    expect(head(rows).event.totalCount).toBe(1);
    expect(store.all(PROJECT)).toEqual([]);

    const card = await gql(api, 'EventCard', { projectId: PROJECT,
      eventId: head(rows).event.originalEventId }, accessToken);

    expect(dataOf(card).project.event).toBeNull();
  });

  it('EventCard returns the original event or null', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);
    const event = store.ingest(PROJECT, 'errors/javascript', { title: 't',
      context: { runId: 'x' } });
    const card = await gql(api, 'EventCard', { projectId: PROJECT,
      eventId: event.id }, accessToken);
    const missing = await gql(api, 'EventCard', { projectId: PROJECT,
      eventId: 'f'.repeat(24) }, accessToken);

    expect(dataOf(card).project.event).toMatchObject({ id: event.id,
      originalEventId: event.id,
      groupHash: event.groupHash,
      totalCount: 1,
      catcherType: 'errors/javascript' });
    expect(missing.body).toEqual({ data: { project: { event: null } } });
  });

  it('RemoveEvent removes and then reports the missing event', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 't' });
    const variables = { projectId: PROJECT,
      eventId: event.id };

    expect((await gql(api, 'RemoveEvent', variables, accessToken)).body).toEqual({ data: { removeEvent: true } });
    expect((await gql(api, 'RemoveEvent', variables, accessToken)).body).toEqual({
      data: null,
      errors: [{ message: `Event not found for eventId: ${event.id}`,
        extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
    });
    expect(api.removeCalls).toBe(2);
  });

  it('rejectRemove false and error leave the event in place', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 't' });
    const variables = { projectId: PROJECT,
      eventId: event.id };

    api.knobs.rejectRemove = 'false';
    expect((await gql(api, 'RemoveEvent', variables, accessToken)).body).toEqual({ data: { removeEvent: false } });

    api.knobs.rejectRemove = 'error';
    expect(errorOf(await gql(api, 'RemoveEvent', variables, accessToken))).toEqual({ message: 'Simulated remove failure',
      extensions: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(store.all(PROJECT)).toHaveLength(1);
    expect(api.removeCalls).toBe(2);
  });

  it('rejectRemove remove_then_timeout removes, hangs once, then behaves normally', async () => {
    const { api, store } = await start();
    const { accessToken } = await login(api);
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 't' });
    const variables = { projectId: PROJECT,
      eventId: event.id };

    api.knobs.rejectRemove = 'remove_then_timeout';

    const headers = new Headers();

    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${accessToken}`);

    const hanging = await fetch(api.url, { method: 'POST',
      headers,
      body: JSON.stringify({ operationName: 'RemoveEvent',
        variables }),
      signal: AbortSignal.timeout(150) }).then(() => 'answered', () => 'timed out');

    expect(hanging).toBe('timed out');
    expect(store.all(PROJECT)).toEqual([]);

    const second = await gql(api, 'RemoveEvent', variables, accessToken);

    expect(errorOf(second).message).toBe(`Event not found for eventId: ${event.id}`);
    expect(api.removeCalls).toBe(2);
  });
});

describe('fake api access rules', () => {
  it('requires a valid access token except for Login and RefreshTokens', async () => {
    const { api } = await start();
    const expected = { data: null,
      errors: [{ message: 'You must be signed in to view this resource.',
        extensions: { code: 'UNAUTHENTICATED' } }] };

    expect((await gql(api, 'ProjectToken', { projectId: PROJECT })).body).toEqual(expected);
    expect((await gql(api, 'WorkspaceQuota', { projectId: PROJECT }, 'bogus')).body).toEqual(expected);
  });

  it('FORBIDDEN for a foreign projectId on project operations', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    for (const name of ['ProjectToken', 'FindEvents', 'EventCard', 'RemoveEvent']) {
      const answer = await gql(api, name, { projectId: 'e'.repeat(24),
        search: 'x',
        eventId: 'f'.repeat(24) }, accessToken);

      expect(errorOf(answer)).toEqual({ message: FORBIDDEN_MESSAGE,
        extensions: { code: 'FORBIDDEN' } });
    }

    expect(api.removeCalls).toBe(0);
  });

  it('expireAccessOnce answers ACCESS_TOKEN_EXPIRED_ERROR exactly once', async () => {
    const { api } = await start();
    const session = await login(api);

    api.knobs.expireAccessOnce = true;

    const expired = await gql(api, 'ProjectToken', { projectId: PROJECT }, session.accessToken);
    const stale = await gql(api, 'ProjectToken', { projectId: PROJECT }, session.accessToken);
    const refreshed = await gql(api, 'RefreshTokens', { refreshToken: session.refreshToken });
    const fresh = await gql(api, 'ProjectToken', { projectId: PROJECT }, dataOf(refreshed).refreshTokens.accessToken);

    expect(errorOf(expired)).toEqual({ message: 'You need to refresh your tokens',
      extensions: { code: 'ACCESS_TOKEN_EXPIRED_ERROR' } });
    expect(errorOf(stale).extensions.code).toBe('UNAUTHENTICATED');
    expect(dataOf(fresh).project.token).toBe(TOKEN);
    expect(api.knobs.expireAccessOnce).toBe(false);
  });

  it('errors knob answers by operationName, limited by times', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    api.knobs.errors = Object.fromEntries([['ProjectToken', { code: 'INTERNAL_SERVER_ERROR',
      message: 'boom',
      times: 1 }]]);

    const first = await gql(api, 'ProjectToken', { projectId: PROJECT }, accessToken);
    const second = await gql(api, 'ProjectToken', { projectId: PROJECT }, accessToken);

    expect(first).toMatchObject({ status: 200,
      body: { data: null,
        errors: [{ message: 'boom',
          extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } });
    expect(dataOf(second).project.token).toBe(TOKEN);

    api.knobs.errors = Object.fromEntries([['Login', { code: 'UNAUTHENTICATED',
      message: 'always' }]]);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(errorOf(await gql(api, 'Login', { email: EMAIL,
        password: PASSWORD })).message).toBe('always');
    }
  });
});

describe('fake api failures and bookkeeping', () => {
  it('unknown or missing operationName is HTTP 400 and not recorded', async () => {
    const { api } = await start();

    for (const name of ['Nope', undefined]) {
      const answer = await gql(api, name);

      expect(answer.status).toBe(400);
      expect(errorOf(answer).extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    }

    expect(api.operations).toEqual([]);
  });

  it('down is 503 text/html for everything and still recorded', async () => {
    const { api } = await start();

    api.knobs.down = true;

    const answer = await gql(api, 'Login', { email: EMAIL,
      password: PASSWORD });

    expect(answer.status).toBe(503);
    expect(answer.type).toContain('text/html');
    expect((await gql(api, undefined)).status).toBe(503);
    expect(api.operations).toEqual(['Login']);

    api.knobs.down = false;
    expect((await gql(api, 'Login', { email: EMAIL,
      password: PASSWORD })).status).toBe(200);
  });

  it('downForMs is down from the first request, then recovers', async () => {
    const { api } = await start();

    api.knobs.downForMs = 150;

    const started = Date.now();

    expect((await gql(api, 'Login')).status).toBe(503);
    await new Promise(resolve => setTimeout(resolve, 200 - (Date.now() - started)));
    expect((await gql(api, 'Login', { email: EMAIL,
      password: PASSWORD })).status).toBe(200);
  });

  it('operations records names in order', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    await gql(api, 'ProjectToken', { projectId: PROJECT }, accessToken);
    await gql(api, 'WorkspaceQuota', { projectId: PROJECT }, accessToken);

    expect(api.operations).toEqual(['Login', 'ProjectToken', 'WorkspaceQuota']);
  });

  it('other paths are 404 plain text', async () => {
    const { api } = await start();
    const response = await fetch(new URL('/other', api.url));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found');
  });
});

describe('fake hawk', () => {
  it('starts both servers over one store and describes itself as env', async () => {
    const hawk = await startFakeHawk();

    try {
      expect(hawk.projectId).toMatch(/^[0-9a-f]{24}$/u);
      expect(fakeHawkEnv(hawk)).toEqual({
        INSTANCE_ID: 'fake',
        HAWK_API_URL: hawk.api.url,
        HAWK_COLLECTOR_URL: hawk.collector.url,
        HAWK_INTEGRATION_TOKEN: hawk.token,
        HAWK_PROJECT_ID: hawk.projectId,
        HAWK_EMAIL: hawk.email,
        HAWK_PASSWORD: hawk.password,
      });

      const response = await fetch(hawk.collector.url, { method: 'POST',
        body: JSON.stringify({ token: hawk.token,
          catcherType: 'errors/nodejs',
          payload: { title: 'via collector' } }) });

      expect(response.status).toBe(200);

      const session = dataOf(await gql(hawk.api, 'Login', { email: hawk.email,
        password: hawk.password })).login;
      const rows = dataOf(await gql(hawk.api, 'FindEvents', { projectId: hawk.projectId,
        search: 'via collector' }, session.accessToken)).project.dailyEventsPortion.dailyEvents;

      expect(rows).toHaveLength(1);
    } finally {
      await hawk.close();
    }
  });
});
