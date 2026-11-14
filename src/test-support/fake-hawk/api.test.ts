import { afterEach, describe, expect, it } from 'vitest';
import { startFakeApi } from './api.js';
import type { FakeApi } from './api.js';
import type { NotificationRule } from '../../notifications/types.js';
import { fakeHawkEnv, startFakeHawk } from './index.js';
import { createFakeRules } from './rules.js';
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
  /** Notification rules. */
  notifications: NotificationRule[];
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
  /** `CreateNotificationRule` result. */
  createProjectNotificationsRule: Record<'id', string>;
  /** `UpdateNotificationRule` result. */
  updateProjectNotificationsRule: Record<'id', string> | null;
  /** `DeleteNotificationRule` result. */
  deleteProjectNotificationsRule: null;
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

/**
 * Builds the input of a rule mutation with the four mandatory channels and a webhook.
 * @param webhookEndpoint Address of the webhook channel.
 * @param extra Other input fields.
 * @returns The `input` variable.
 */
function ruleInput(webhookEndpoint = 'https://example.com/hooks/webhook/s', extra: Record<string, unknown> = {}): Record<string, unknown> {
  const off = { isEnabled: false,
    endpoint: '' };

  return { projectId: PROJECT,
    including: ['[e2e:t]'],
    channels: { email: off,
      slack: off,
      loop: off,
      telegram: off,
      webhook: { endpoint: webhookEndpoint } },
    ...extra };
}

/**
 * Reads the rules of the project through the API.
 * @param api Target API.
 * @param accessToken Bearer token.
 * @returns Rules as the `NotificationRules` query returns them.
 */
async function rulesThrough(api: FakeApi, accessToken: string): Promise<NotificationRule[]> {
  return dataOf(await gql(api, 'NotificationRules', { projectId: PROJECT }, accessToken)).project.notifications;
}

describe('fake api notification rules', () => {
  it('a project starts with the default rule: SEEN_MORE, email on, webhook null', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const [rule, ...rest] = await rulesThrough(api, accessToken);

    expect(rest).toEqual([]);
    expect(rule).toMatchObject({ whatToReceive: 'SEEN_MORE',
      threshold: 20,
      thresholdPeriod: 3_600_000 });
    expect(rule?.channels.email).toEqual({ isEnabled: true,
      endpoint: EMAIL,
      minPeriod: 60 });
    expect(rule?.channels.webhook).toBeNull();
  });

  it('create answers with an id and the rule goes first', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const created = dataOf(await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken));
    const rules = await rulesThrough(api, accessToken);

    expect(rules).toHaveLength(2);
    expect(rules[0]?.id).toBe(created.createProjectNotificationsRule.id);
    expect(rules[0]).toMatchObject({ isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: ['[e2e:t]'],
      excluding: [] });
    expect(rules[0]?.channels.webhook).toEqual({ isEnabled: true,
      endpoint: 'https://example.com/hooks/webhook/s',
      minPeriod: 60 });
  });

  it('update replaces the rule, an unknown rule gives null', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const { id } = dataOf(await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken)).createProjectNotificationsRule;
    const updated = dataOf(await gql(api, 'UpdateNotificationRule', { input: { ...ruleInput('https://example.com/new'),
      ruleId: id } }, accessToken));
    const missing = dataOf(await gql(api, 'UpdateNotificationRule', { input: { ...ruleInput(),
      ruleId: 'f'.repeat(24) } }, accessToken));

    expect(updated.updateProjectNotificationsRule).toEqual({ id });
    expect(missing.updateProjectNotificationsRule).toBeNull();
    expect((await rulesThrough(api, accessToken))[0]?.channels.webhook?.endpoint).toBe('https://example.com/new');
  });

  it('delete returns null and removes', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const { id } = dataOf(await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken)).createProjectNotificationsRule;
    const answer = await gql(api, 'DeleteNotificationRule', { input: { projectId: PROJECT,
      ruleId: id } }, accessToken);

    expect(answer.body).toEqual({ data: { deleteProjectNotificationsRule: null } });
    expect(await rulesThrough(api, accessToken)).toHaveLength(1);
  });

  it.each([
    ['NotificationRules', { projectId: 'c'.repeat(24) }],
    ['CreateNotificationRule', { input: { ...ruleInput(),
      projectId: 'c'.repeat(24) } }],
    ['UpdateNotificationRule', { input: { ...ruleInput(),
      projectId: 'c'.repeat(24),
      ruleId: 'x' } }],
    ['DeleteNotificationRule', { input: { projectId: 'c'.repeat(24),
      ruleId: 'x' } }],
  ])('%s for a foreign project is FORBIDDEN', async (name, variables) => {
    const { api } = await start();
    const { accessToken } = await login(api);

    expect(errorOf(await gql(api, name, variables, accessToken))).toEqual({ message: FORBIDDEN_MESSAGE,
      extensions: { code: 'FORBIDDEN' } });
    expect(await rulesThrough(api, accessToken)).toHaveLength(1);
  });

  it('the project mutations of the own project are not FORBIDDEN', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    expect((await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken)).body.errors).toBeUndefined();
  });

  it('validation errors come with the code and text of Hawk', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const noEmail = ruleInput();
    const channels = noEmail.channels as Record<string, unknown>;

    api.knobs.allowPrivateWebhook = false;

    const port = errorOf(await gql(api, 'CreateNotificationRule', { input: ruleInput('https://example.com:8443/x') }, accessToken));

    delete channels.email;

    const missing = errorOf(await gql(api, 'CreateNotificationRule', { input: noEmail }, accessToken));

    expect(port).toEqual({ message: 'Webhook URL port 8443 is not allowed — only 80 (http) and 443 (https)',
      extensions: { code: 'BAD_USER_INPUT' } });
    expect(missing).toEqual({ message: `Cannot read properties of undefined (reading 'isEnabled')`,
      extensions: { code: 'INTERNAL_SERVER_ERROR' } });
  });

  it('allowPrivateWebhook is true by default and flips at any time', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const local = ruleInput('http://127.0.0.1:54321/hooks/webhook/s');

    expect((await gql(api, 'CreateNotificationRule', { input: local }, accessToken)).body.errors).toBeUndefined();

    api.knobs.allowPrivateWebhook = false;

    expect(errorOf(await gql(api, 'CreateNotificationRule', { input: local }, accessToken)).message).toContain('port 54321');
  });

  it('unresolvableHosts are rejected', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    api.knobs.unresolvableHosts = ['gone.example.com'];

    expect(errorOf(await gql(api, 'CreateNotificationRule', { input: ruleInput('https://gone.example.com/x') }, accessToken)).message)
      .toBe('Cannot resolve webhook hostname "gone.example.com"');
  });

  it('the errors knob works by the name of a rule operation', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    api.knobs.errors = Object.fromEntries([['UpdateNotificationRule', { code: 'FORBIDDEN',
      message: 'Not enough permissions' }]]);

    expect(errorOf(await gql(api, 'UpdateNotificationRule', { input: { ...ruleInput(),
      ruleId: 'x' } }, accessToken))).toEqual({ message: 'Not enough permissions',
      extensions: { code: 'FORBIDDEN' } });
  });

  it('createThenHang creates the rule, never answers once, then behaves normally', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);
    const headers = new Headers();
    const abort = new AbortController();

    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${accessToken}`);
    api.knobs.createThenHang = true;

    const hanging = fetch(api.url, { method: 'POST',
      headers,
      body: JSON.stringify({ operationName: 'CreateNotificationRule',
        variables: { input: ruleInput() } }),
      signal: abort.signal }).then(() => 'answered', () => 'aborted');

    // The rule shows up although the answer never does; the client gives up only then.
    while ((await rulesThrough(api, accessToken)).length < 2) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    abort.abort();

    expect(await hanging).toBe('aborted');

    const second = dataOf(await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken));

    expect(second.createProjectNotificationsRule.id).toMatch(/^[0-9a-f]{24}$/u);
    expect(await rulesThrough(api, accessToken)).toHaveLength(3);
  });

  it('operations records the rule operations', async () => {
    const { api } = await start();
    const { accessToken } = await login(api);

    await rulesThrough(api, accessToken);
    await gql(api, 'CreateNotificationRule', { input: ruleInput() }, accessToken);

    expect(api.operations).toEqual(['Login', 'NotificationRules', 'CreateNotificationRule']);
  });

  it('uses the rules it is given and seeds the default rule into them', async () => {
    const rules = createFakeRules({ allowPrivateWebhook: () => true,
      resolves: () => true });
    const store = createFakeStore();
    const api = await startFakeApi({ store,
      projectId: PROJECT,
      email: EMAIL,
      password: PASSWORD,
      token: TOKEN,
      rules });

    apis.push(api);

    expect(api.rules).toBe(rules);
    expect(rules.list(PROJECT)).toHaveLength(1);
    expect(rules.list(PROJECT)[0]?.channels.email.endpoint).toBe(EMAIL);
  });

  it('fake hawk shares one rule store between its parts and reads the knobs lazily', async () => {
    const hawk = await startFakeHawk();

    try {
      expect(hawk.rules).toBe(hawk.api.rules);
      expect(hawk.rules.list(hawk.projectId)).toHaveLength(1);

      hawk.api.knobs.allowPrivateWebhook = false;

      const rejected = hawk.rules.create(hawk.projectId, { ...ruleInput('http://127.0.0.1:1234/x'),
        projectId: hawk.projectId });

      expect(rejected).toMatchObject({ code: 'BAD_USER_INPUT' });
    } finally {
      await hawk.close();
    }
  });
});
