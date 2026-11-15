import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeRules } from './rules.js';
import { createFakeRules, defaultRule } from './rules.js';
import type { FakeStore, StoredEvent } from './store.js';
import { objectIdLike } from './store.js';
import { PLAIN_TYPE } from './content-types.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const DEFAULT_EVENTS_LIMIT = 10_000;
const UNAUTHENTICATED_MESSAGE = 'You must be signed in to view this resource.';
// The ProjectDailyEvents query asks for 50 rows.
const PAGE_LIMIT = 50;
const RULE_MUTATIONS = new Set(['CreateNotificationRule', 'UpdateNotificationRule', 'DeleteNotificationRule']);
const PROJECT_OPERATIONS = new Set(['ProjectToken', 'ProjectDailyEvents', 'Event', 'RemoveEvent', 'NotificationRules', ...RULE_MUTATIONS]);
const OPERATIONS = new Set(['Login', 'RefreshTokens', 'ProjectToken', 'WorkspaceQuota', 'ProjectDailyEvents', 'Event', 'RemoveEvent', 'NotificationRules', ...RULE_MUTATIONS]);
const ANONYMOUS_OPERATIONS = new Set(['Login', 'RefreshTokens']);

/** A GraphQL error the fake can be told to return. */
export interface FakeApiError {
  /** `extensions.code`. */
  code: string;
  /** Error message. */
  message: string;
  /** How many requests get the error; unlimited by default. */
  times?: number;
  /** HTTP status of the answer, 200 by default; Apollo answers 400 for a document that fails validation. */
  status?: number;
}

/** Workspace the fake reports for the project. */
export interface FakeWorkspace {
  /** Workspace `isBlocked`. */
  isBlocked: boolean;
  /** Plan `eventsLimit`. */
  eventsLimit: number;
  /** `billingPeriodEventsCount`, null as in a fresh workspace. */
  billingPeriodEventsCount: number | null;
  /** Null means the workspace has no plan. */
  plan?: null;
}

/** Failure switches of the fake API; tests change them at any time. */
export interface FakeApiKnobs {
  /** Answers 503 text/html to everything. */
  down?: boolean;
  /** Down for this long, counted from the first request that sees the value. */
  downForMs?: number;
  /** GraphQL errors by operationName, HTTP 200 with `data: null`. */
  errors?: Partial<Record<string, FakeApiError>>;
  /** The next request with a known access token gets ACCESS_TOKEN_EXPIRED_ERROR. */
  expireAccessOnce?: boolean;
  /** How `RemoveEvent` fails. */
  rejectRemove?: 'false' | 'error' | 'remove_then_timeout';
  /** Replaces `project.token`. */
  projectToken?: string;
  /** Replaces the workspace data. */
  workspace?: FakeWorkspace;
  /** Search also returns an event of someone else with the same runId in its title. */
  foreignEvent?: boolean;
  /** Webhooks may point to private addresses and other ports, loop may use http; true when unset, as tests run on 127.0.0.1. */
  allowPrivateWebhook?: boolean;
  /** Hosts the fake DNS does not resolve. */
  unresolvableHosts?: string[];
  /** The next `CreateNotificationRule` creates the rule and never answers; the client has to give up. */
  createThenHang?: boolean;
}

/** Running fake GraphQL API. */
export interface FakeApi {
  /** `http://127.0.0.1:<port>/graphql`. */
  readonly url: string;
  /** Mutable switches. */
  readonly knobs: FakeApiKnobs;
  /** Names of known operations in arrival order, including requests answered 503. */
  readonly operations: string[];
  /** Number of `RemoveEvent` requests that reached the handler. */
  readonly removeCalls: number;
  /** Notification rules of the project, with the default rule already in. */
  readonly rules: FakeRules;
  /**
   * Stops the server and drops connections, including hanging ones.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

/** Inputs of the fake API. */
export interface FakeApiOptions {
  /** Events behind the API. */
  store: FakeStore;
  /** The only project the API knows. */
  projectId: string;
  /** Account email. */
  email: string;
  /** Account password. */
  password: string;
  /** Integration token returned as `project.token`. */
  token: string;
  /** Rule store to use, shared with a notifier; the API makes its own when absent. The default rule of the account is put into it at start. */
  rules?: FakeRules;
}

/** Result of an operation: data or an error. */
interface Outcome {
  /** HTTP status. */
  status: number;
  /** Response JSON. */
  json: unknown;
}

/**
 * Builds a GraphQL error answer.
 * @param message Error message.
 * @param code `extensions.code`.
 * @param status HTTP status, 200 by default.
 * @returns Outcome with `data: null`.
 */
function failure(message: string, code: string, status = 200): Outcome {
  return { status,
    json: { data: null,
      errors: [{ message,
        extensions: { code } }] } };
}

/**
 * Wraps data in a successful outcome.
 * @param data The `data` object.
 * @returns HTTP 200 outcome.
 */
function success(data: unknown): Outcome {
  return { status: 200,
    json: { data } };
}

/**
 * Reads a string variable.
 * @param variables Operation variables.
 * @param key Variable name.
 * @returns The value, '' when missing or not a string.
 */
function variable(variables: Record<string, unknown>, key: string): string {
  const value = variables[key];

  return typeof value === 'string' ? value : '';
}

/**
 * Renders an event the way the client queries select it.
 * @param event Stored event.
 * @param eventId Value of the `id` field, the original or the latest repetition id.
 * @returns Event object with title and context normalized.
 */
function eventView(event: StoredEvent, eventId: string): Record<string, unknown> {
  const { title, context } = event.payload;
  const { payload } = event;

  return {
    id: eventId,
    originalEventId: event.id,
    groupHash: event.groupHash,
    totalCount: event.totalCount,
    catcherType: event.catcherType,
    timestamp: event.timestamp,
    originalTimestamp: event.timestamp,
    isNew: event.totalCount === 1,
    usersAffected: event.usersAffected,
    payload: {
      title: typeof title === 'string' && title !== '' ? title : 'Unknown',
      type: payload.type,
      release: payload.release,
      user: payload.user,
      get: payload.get,
      backtrace: payload.backtrace,
      addons: payload.addons,
      breadcrumbs: payload.breadcrumbs,
      context: typeof context === 'object' && context !== null && !Array.isArray(context) ? context : {},
    },
  };
}

/**
 * Starts a fake Hawk GraphQL API on a random loopback port.
 * @param options Store, project and account data.
 * @returns The running API.
 */
export async function startFakeApi(options: FakeApiOptions): Promise<FakeApi> {
  const { store, projectId } = options;
  const knobs: FakeApiKnobs = {};
  const rules = options.rules ?? createFakeRules({ allowPrivateWebhook: () => knobs.allowPrivateWebhook ?? true,
    resolves: host => knobs.unresolvableHosts?.includes(host) !== true });

  rules.seed(projectId, defaultRule(options.email));
  const operations: string[] = [];
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const errorUses = new WeakMap<FakeApiError, number>();
  let removeCalls = 0;
  let removeTimeoutUsed = false;
  let createHangUsed = false;
  let seenDownForMs: number | undefined;
  let downUntil = 0;

  const issueTokens = (field: 'login' | 'refreshTokens'): Outcome => {
    const accessToken = randomBytes(16).toString('hex');
    const refreshToken = randomBytes(16).toString('hex');

    accessTokens.add(accessToken);
    refreshTokens.add(refreshToken);

    return success({ [field]: { accessToken,
      refreshToken } });
  };

  const isDown = (): boolean => {
    if (knobs.down === true) {
      return true;
    }

    if (knobs.downForMs !== seenDownForMs) {
      seenDownForMs = knobs.downForMs;
      downUntil = knobs.downForMs === undefined ? 0 : Date.now() + knobs.downForMs;
    }

    return Date.now() < downUntil;
  };

  const takeError = (name: string): FakeApiError | undefined => {
    const entry = knobs.errors?.[name];

    if (!entry) {
      return undefined;
    }

    const used = errorUses.get(entry) ?? 0;

    if (entry.times !== undefined && used >= entry.times) {
      return undefined;
    }

    errorUses.set(entry, used + 1);

    return entry;
  };

  const workspaceQuota = (id: string): Outcome => {
    const workspace = knobs.workspace ?? { isBlocked: false,
      eventsLimit: DEFAULT_EVENTS_LIMIT,
      billingPeriodEventsCount: 0 };
    const plan = workspace.plan === null ? null : { eventsLimit: workspace.eventsLimit };

    return success({
      workspaces: [
        { id: 'foreign-workspace',
          isBlocked: false,
          billingPeriodEventsCount: 0,
          plan: { eventsLimit: DEFAULT_EVENTS_LIMIT },
          projects: [] },
        { id: 'fake-workspace',
          isBlocked: workspace.isBlocked,
          billingPeriodEventsCount: workspace.billingPeriodEventsCount,
          plan,
          projects: id === projectId ? [{ id }] : [] },
      ],
    });
  };

  const findEvents = (search: string): Outcome => {
    // Hawk compiles the raw search as a regex and rejects what does not parse.
    try {
      new RegExp(search);
    } catch {
      return failure('Invalid regular expression pattern', 'INTERNAL_SERVER_ERROR');
    }

    const rows: unknown[] = store.search(projectId, search).slice(0, PAGE_LIMIT)
      .map(event => ({
        id: event.id,
        count: event.totalCount,
        event: eventView(event, event.lastRepetitionId ?? event.id),
      }));

    if (knobs.foreignEvent === true) {
      const foreignId = objectIdLike();

      rows.push({ id: foreignId,
        count: 1,
        event: { id: foreignId,
          originalEventId: foreignId,
          groupHash: objectIdLike(),
          totalCount: 1,
          catcherType: 'errors/nodejs',
          payload: { title: `foreign ${search}`,
            context: {} } } });
    }

    return success({ project: { dailyEventsPortion: { dailyEvents: rows } } });
  };

  const removeEvent = (eventId: string): Outcome | 'hang' => {
    removeCalls += 1;

    if (knobs.rejectRemove === 'false') {
      return success({ removeEvent: false });
    }

    if (knobs.rejectRemove === 'error') {
      return failure('Simulated remove failure', 'INTERNAL_SERVER_ERROR');
    }

    const removed = store.remove(projectId, eventId);

    if (knobs.rejectRemove === 'remove_then_timeout' && !removeTimeoutUsed) {
      removeTimeoutUsed = true;

      return 'hang';
    }

    return removed
      ? success({ removeEvent: true })
      : failure(`Event not found for eventId: ${eventId}`, 'INTERNAL_SERVER_ERROR');
  };

  const notificationRules = (): Outcome => success({
    project: { id: projectId,
      notifications: rules.list(projectId).map(rule => ({ ...rule,
        threshold: rule.threshold ?? null,
        thresholdPeriod: rule.thresholdPeriod ?? null })) },
  });

  const inputOf = (variables: Record<string, unknown>): Record<string, unknown> => {
    const { input } = variables;

    return typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  };

  const createRule = (variables: Record<string, unknown>): Outcome | 'hang' => {
    const created = rules.create(projectId, inputOf(variables));

    if ('code' in created) {
      return failure(created.message, created.code);
    }

    if (knobs.createThenHang === true && !createHangUsed) {
      createHangUsed = true;

      return 'hang';
    }

    return success({ createProjectNotificationsRule: { id: created.id } });
  };

  const updateRule = (variables: Record<string, unknown>): Outcome => {
    const updated = rules.update(projectId, inputOf(variables));

    if (updated !== null && 'code' in updated) {
      return failure(updated.message, updated.code);
    }

    return success({ updateProjectNotificationsRule: updated === null ? null : { id: updated.id } });
  };

  const run = (name: string, variables: Record<string, unknown>): Outcome | 'hang' => {
    switch (name) {
      case 'Login':
        return variable(variables, 'email') === options.email && variable(variables, 'password') === options.password
          ? issueTokens('login')
          : failure('Wrong email or password', 'UNAUTHENTICATED');
      case 'RefreshTokens': {
        const refreshToken = variable(variables, 'refreshToken');

        if (!refreshTokens.delete(refreshToken)) {
          return failure('Invalid refresh token', 'UNAUTHENTICATED');
        }

        return issueTokens('refreshTokens');
      }
      case 'ProjectToken':
        return success({ project: { token: knobs.projectToken ?? options.token } });
      case 'WorkspaceQuota':
        return workspaceQuota(variable(variables, 'projectId'));
      case 'ProjectDailyEvents':
        return findEvents(variable(variables, 'search'));
      case 'Event': {
        const event = store.get(projectId, variable(variables, 'eventId'));

        return success({ project: { event: event ? eventView(event, event.id) : null } });
      }
      case 'NotificationRules':
        return notificationRules();
      case 'CreateNotificationRule':
        return createRule(variables);
      case 'UpdateNotificationRule':
        return updateRule(variables);
      case 'DeleteNotificationRule':
        rules.remove(projectId, typeof inputOf(variables).ruleId === 'string' ? inputOf(variables).ruleId as string : '');

        return success({ deleteProjectNotificationsRule: null });
      default:
        return removeEvent(variable(variables, 'eventId'));
    }
  };

  const answer = (request: IncomingMessage, name: string, variables: Record<string, unknown>): Outcome | 'hang' => {
    const injected = takeError(name);

    if (injected) {
      return failure(injected.message, injected.code, injected.status);
    }

    if (!ANONYMOUS_OPERATIONS.has(name)) {
      const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1];

      if (bearer === undefined || !accessTokens.has(bearer)) {
        return failure(UNAUTHENTICATED_MESSAGE, 'UNAUTHENTICATED');
      }

      if (knobs.expireAccessOnce === true) {
        knobs.expireAccessOnce = false;
        accessTokens.delete(bearer);

        return failure('You need to refresh your tokens', 'ACCESS_TOKEN_EXPIRED_ERROR');
      }
    }

    // The rule mutations carry the project in `input`, the other operations at the top.
    const requested = RULE_MUTATIONS.has(name) ? variable(inputOf(variables), 'projectId') : variable(variables, 'projectId');

    if (PROJECT_OPERATIONS.has(name) && requested !== projectId) {
      return failure('You have no access to this workspace', 'FORBIDDEN');
    }

    return run(name, variables);
  };

  const respond = (response: ServerResponse, status: number, type: string, body: string): void => {
    response.statusCode = status;
    response.setHeader('content-type', type);
    response.end(body);
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/graphql') {
      respond(response, 404, PLAIN_TYPE, 'Not found');

      return;
    }

    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: Record<string, unknown> = {};

      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        // An unreadable body is answered like a missing operationName.
      }

      const name = typeof body.operationName === 'string' && OPERATIONS.has(body.operationName) ? body.operationName : undefined;

      if (name !== undefined) {
        operations.push(name);
      }

      if (isDown()) {
        respond(response, 503, 'text/html', '<html><body>Service Unavailable</body></html>');

        return;
      }

      if (name === undefined) {
        respond(response, 400, JSON_TYPE, JSON.stringify({
          errors: [{ message: 'Unknown or missing operationName',
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
        }));

        return;
      }

      const variables = typeof body.variables === 'object' && body.variables !== null
        ? body.variables as Record<string, unknown>
        : {};
      const outcome = answer(request, name, variables);

      if (outcome !== 'hang') {
        respond(response, outcome.status, JSON_TYPE, JSON.stringify(outcome.json));
      }
    });
  };

  const server = createServer(handle);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/graphql`,
    knobs,
    operations,
    get removeCalls() {
      return removeCalls;
    },
    rules,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
