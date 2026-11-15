import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCheckError } from '../errors/taxonomy.js';
import type { CheckError } from '../errors/taxonomy.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeApiError, FakeHawk } from '../test-support/fake-hawk/index.js';
import { systemClock } from '../time/clock.js';
import { createGraphqlTransport } from './graphql.js';
import type { GraphqlOperation, GraphqlTransport } from './graphql.js';
import type { RetryPolicy } from '../net/retry.js';
import type { NotificationRule, NotificationRuleInput } from '../notifications/types.js';
import { createHawkApi } from './hawk-api.js';
import type { HawkApi } from './hawk-api.js';

let hawk: FakeHawk;
let signal: AbortSignal;

/**
 * Builds a client for the running fake.
 * @param password Account password, the right one by default.
 * @param httpTimeoutMs Deadline of one request.
 * @param removeRetry Attempts and pauses of removing an event, 3 attempts with 1 ms pauses by default.
 * @returns Client with 1 ms retry delays.
 */
function apiFor(password = hawk.password, httpTimeoutMs = 1000, removeRetry: RetryPolicy = { attempts: 3,
  delaysMs: [1] }): HawkApi {
  return createHawkApi({ transport: createGraphqlTransport({ url: hawk.api.url,
    httpTimeoutMs,
    clock: systemClock,
    retry: { attempts: 3,
      delaysMs: [1, 1] } }),
  email: hawk.email,
  password,
  clock: systemClock,
  retry: removeRetry });
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

  it('a refresh answered with an API error does not fall back to login', async () => {
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

describe('hawk api queries', () => {
  const eventPayload = (title: string): Record<string, unknown> => ({ title,
    context: { runId: 'run1' } });

  it('workspaceQuota reads the workspace of the project', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 500,
      billingPeriodEventsCount: 42 };

    expect(await apiFor().workspaceQuota(hawk.projectId, signal)).toEqual({ workspaceId: 'fake-workspace',
      isBlocked: false,
      eventsLimit: 500,
      eventsCount: 42 });
  });

  it('workspaceQuota treats a null counter as 0 and passes isBlocked', async () => {
    hawk.api.knobs.workspace = { isBlocked: true,
      eventsLimit: 10,
      billingPeriodEventsCount: null };

    const quota = await apiFor().workspaceQuota(hawk.projectId, signal);

    expect(quota.eventsCount).toBe(0);
    expect(quota.isBlocked).toBe(true);
  });

  it('workspace with plan null is api_error', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 1,
      billingPeriodEventsCount: 0,
      plan: null };

    const error = await checkErrorOf(apiFor().workspaceQuota(hawk.projectId, signal));

    expect(error.errorClass).toBe('api_error');
    expect(error.facts.detail).toBe('workspace has no plan');
  });

  it('project outside workspaces is api_forbidden', async () => {
    const error = await checkErrorOf(apiFor().workspaceQuota('c'.repeat(24), signal));

    expect(error.errorClass).toBe('api_forbidden');
    expect(error.facts.projectId).toBe('c'.repeat(24));
  });

  it('findEvents finds a stored event', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('[e2e:fake] runabc find'));
    const found = await apiFor().findEvents(hawk.projectId, 'runabc', signal);

    expect(found).toEqual([{ originalEventId: stored.id,
      groupHash: stored.groupHash,
      totalCount: 1,
      catcherType: 'errors/nodejs',
      title: '[e2e:fake] runabc find',
      context: { runId: 'run1' },
      timestamp: stored.timestamp * 1000 }]);
  });

  it('findEvents and eventCard turn the Unix seconds of Hawk into milliseconds', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('[e2e:fake] runsec'));

    hawk.store.setTimestamp(hawk.projectId, stored.id, 1_794_699_912);

    const [found] = await apiFor().findEvents(hawk.projectId, 'runsec', signal);
    const card = await apiFor().eventCard(hawk.projectId, stored.id, signal);

    expect(found?.timestamp).toBe(1_794_699_912_000);
    expect(card?.timestamp).toBe(1_794_699_912_000);
  });

  it('a timestamp that is already in milliseconds is kept', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('[e2e:fake] runms'));

    hawk.store.setTimestamp(hawk.projectId, stored.id, 1_794_699_912_345);

    const [found] = await apiFor().findEvents(hawk.projectId, 'runms', signal);

    expect(found?.timestamp).toBe(1_794_699_912_345);
  });

  it('a foreign event without a timestamp has none', async () => {
    hawk.api.knobs.foreignEvent = true;

    const [found] = await apiFor().findEvents(hawk.projectId, 'runnone', signal);

    expect(found?.timestamp).toBeUndefined();
  });

  it('findEvents returns an empty list when nothing matches', async () => {
    expect(await apiFor().findEvents(hawk.projectId, 'nothing', signal)).toEqual([]);
  });

  it('findEvents returns original id after a repeat', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('repeat me'));

    hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('repeat me'));

    const [found] = await apiFor().findEvents(hawk.projectId, 'repeat me', signal);

    expect(stored.lastRepetitionId).toBeDefined();
    expect(found?.originalEventId).toBe(stored.id);
    expect(found?.totalCount).toBe(2);
  });

  it('findEvents includes the foreign event', async () => {
    hawk.api.knobs.foreignEvent = true;

    const found = await apiFor().findEvents(hawk.projectId, 'runxyz', signal);

    expect(found.map(event => event.title)).toEqual(['foreign runxyz']);
  });

  it('eventCard returns the event, or null when it is gone', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/javascript', eventPayload('card'));
    const api = apiFor();
    const card = await api.eventCard(hawk.projectId, stored.id, signal);

    expect(card).toMatchObject({ originalEventId: stored.id,
      catcherType: 'errors/javascript',
      title: 'card',
      totalCount: 1 });
    expect(await api.eventCard(hawk.projectId, 'f'.repeat(24), signal)).toBeNull();
  });

  it('removeEvent removes the event', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('to remove'));

    expect(await apiFor().removeEvent(hawk.projectId, stored.id, signal)).toBe(true);
    expect(hawk.store.all(hawk.projectId)).toEqual([]);
  });

  it('remove false is returned as false', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('stays'));

    hawk.api.knobs.rejectRemove = 'false';

    expect(await apiFor().removeEvent(hawk.projectId, stored.id, signal)).toBe(false);
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('remove error is api_error and is not repeated', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('stays'));

    hawk.api.knobs.rejectRemove = 'error';

    const error = await checkErrorOf(apiFor().removeEvent(hawk.projectId, stored.id, signal));

    expect(error.errorClass).toBe('api_error');
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('remove of an unknown event on the first attempt is api_error', async () => {
    const error = await checkErrorOf(apiFor().removeEvent(hawk.projectId, 'f'.repeat(24), signal));

    expect(error.errorClass).toBe('api_error');
    expect(error.facts.detail).toContain('Event not found for eventId');
  });

  it('remove succeeds when the first attempt removed but timed out', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('half removed'));

    hawk.api.knobs.rejectRemove = 'remove_then_timeout';

    expect(await apiFor(hawk.password, 100).removeEvent(hawk.projectId, stored.id, signal)).toBe(true);
    expect(hawk.api.removeCalls).toBe(2);
    expect(hawk.store.all(hawk.projectId)).toEqual([]);
  });

  it('remove gives up after three unavailable attempts', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('down'));
    const api = apiFor();

    await api.ensureSession(signal);
    hawk.api.knobs.down = true;

    expect((await checkErrorOf(api.removeEvent(hawk.projectId, stored.id, signal))).errorClass).toBe('api_unavailable');
    expect(hawk.api.operations.filter(name => name === 'RemoveEvent')).toHaveLength(3);
  });

  it('remove uses the configured number of attempts', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', eventPayload('down'));
    const api = apiFor(hawk.password, 1000, { attempts: 2,
      delaysMs: [1] });

    await api.ensureSession(signal);
    hawk.api.knobs.down = true;
    hawk.api.operations.length = 0;

    expect((await checkErrorOf(api.removeEvent(hawk.projectId, stored.id, signal))).errorClass).toBe('api_unavailable');
    expect(hawk.api.operations.filter(name => name === 'RemoveEvent')).toHaveLength(2);
  });
});

describe('notification rules', () => {
  const input = (): NotificationRuleInput => {
    const off = { isEnabled: false,
      endpoint: '' };

    return { projectId: hawk.projectId,
      isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: ['[e2e:api-test]'],
      excluding: [],
      channels: { email: off,
        slack: off,
        loop: off,
        telegram: off,
        webhook: { isEnabled: true,
          endpoint: 'https://hooks.example.com/hooks/webhook/x' } } };
  };

  it('reads the default rule with a null webhook', async () => {
    const rules = await apiFor().notificationRules(hawk.projectId, signal);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.channels.webhook).toBeNull();
    expect(rules[0]?.channels.email.isEnabled).toBe(true);
  });

  it('turns a null channel into a disabled one', async () => {
    const [rule] = hawk.rules.list(hawk.projectId);

    hawk.rules.remove(hawk.projectId, rule?.id ?? '');
    hawk.rules.seed(hawk.projectId, { ...rule as NotificationRule,
      channels: { ...rule?.channels,
        slack: null } as unknown as NotificationRule['channels'] });

    const [read] = await apiFor().notificationRules(hawk.projectId, signal);

    expect(read?.channels.slack).toEqual({ isEnabled: false,
      endpoint: '' });
  });

  it('creates, updates and deletes a rule', async () => {
    const api = apiFor();
    const id = await api.createNotificationRule(input(), signal);

    expect((await api.notificationRules(hawk.projectId, signal))[0]?.id).toBe(id);
    expect(await api.updateNotificationRule({ ...input(),
      ruleId: id,
      isEnabled: false }, signal)).toBe(id);
    expect((await api.notificationRules(hawk.projectId, signal))[0]?.isEnabled).toBe(false);

    await api.deleteNotificationRule(hawk.projectId, id, signal);

    expect((await api.notificationRules(hawk.projectId, signal)).map(rule => rule.id)).not.toContain(id);
  });

  it('update of an unknown rule gives null', async () => {
    expect(await apiFor().updateNotificationRule({ ...input(),
      ruleId: 'f'.repeat(24) }, signal)).toBeNull();
  });

  it('create is not repeated after a timeout', async () => {
    hawk.api.knobs.createThenHang = true;

    const error = await checkErrorOf(apiFor(hawk.password, 100).createNotificationRule(input(), signal));

    expect(error.errorClass).toBe('api_unavailable');
    expect(hawk.api.operations.filter(name => name === 'CreateNotificationRule')).toHaveLength(1);
  });

  it('an unknown project is api_forbidden', async () => {
    const transport: GraphqlTransport = {
      request: async <T>(operation: GraphqlOperation): Promise<T> => Promise.resolve((operation.name === 'Login'
        ? { login: { accessToken: 'a',
            refreshToken: 'r' } }
        : { project: null }) as T),
    };
    const api = createHawkApi({ transport,
      email: 'e',
      password: 'p',
      clock: systemClock,
      retry: { attempts: 3,
        delaysMs: [1] } });

    expect((await checkErrorOf(api.notificationRules(hawk.projectId, signal))).errorClass).toBe('api_forbidden');
  });
});
