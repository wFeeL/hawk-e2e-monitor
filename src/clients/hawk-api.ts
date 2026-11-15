import { CheckError, isCheckError } from '../errors/taxonomy.js';
import type { ErrorClass } from '../errors/taxonomy.js';
import type { RetryPolicy } from '../net/retry.js';
import type { Clock } from '../time/clock.js';
import { ACCESS_EXPIRED, GraphqlFailure, UNAUTHENTICATED } from './graphql.js';
import type { GraphqlOperation, GraphqlTransport } from './graphql.js';
import type { ChannelSettings, NotificationRule, NotificationRuleInput, NotificationRuleUpdate } from '../notifications/types.js';
import { CREATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE, EVENT, PROJECT_DAILY_EVENTS, LOGIN, NOTIFICATION_RULES, PROJECT_TOKEN, REFRESH_TOKENS, REMOVE_EVENT, UPDATE_NOTIFICATION_RULE, WORKSPACE_QUOTA } from './operations.js';
import { MS_PER_SECOND } from '../time/units.js';

const NOT_FOUND_PREFIX = 'Event not found for eventId';
const RETRYABLE_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>(['api_unavailable', 'dns_error', 'network_error', 'tls_error']);
// Unix seconds stay below this until the year 5138; anything above is already milliseconds.
const MILLISECONDS_THRESHOLD = 1e11;

/** Workspace of the project with its event limit. */
export interface WorkspaceQuota {
  /** Workspace id. */
  workspaceId: string;
  /** True when Hawk blocked the workspace. */
  isBlocked: boolean;
  /** Events the plan allows per billing period. */
  eventsLimit: number;
  /** Events counted in the current billing period. */
  eventsCount: number;
}

/** An event as the API shows it. */
export interface FoundEvent {
  /** Id of the first event of the group, not of the last repetition. */
  originalEventId: string;
  /** Hash that groups repetitions. */
  groupHash: string;
  /** How many times the event happened. */
  totalCount: number;
  /** Catcher type the event was sent with. */
  catcherType: string;
  /** Title of the event. */
  title: string;
  /** Context object as Hawk returns it, null when absent. */
  context: unknown;
  /** When the event first arrived, in milliseconds; absent when Hawk gave no time. */
  timestamp?: number;
}

/** Event card as the page of an event in Garage reads it: a search row and the fields of the payload. */
export interface EventCard extends FoundEvent {
  /** Event type, such as the error class. */
  type?: string | null;
  /** Release the event was sent with. */
  release?: string | null;
  /** User the event happened to. */
  user?: unknown;
  /** Query parameters of the request. */
  get?: unknown;
  /** Stack frames. */
  backtrace?: unknown;
  /** Extra data of the catcher. */
  addons?: unknown;
  /** Trail of events before the error. */
  breadcrumbs?: unknown;
  /** Number of users the event happened to. */
  usersAffected?: number | null;
}

/** Accounts and waits the client needs. */
export interface HawkApiOptions {
  /** Sends GraphQL operations. */
  transport: GraphqlTransport;
  /** Email of the monitor account. */
  email: string;
  /** Password of the monitor account. */
  password: string;
  /** Clock for pauses between attempts. */
  clock: Clock;
  /** Attempts and pauses of a repeated call, such as removing an event. */
  retry: RetryPolicy;
}

/** Calls of the Hawk API that the monitor makes. */
export interface HawkApi {
  /**
   * Signs in when there is no session yet.
   * @param signal Deadline of the caller.
   * @returns Resolves when tokens are held.
   * @throws CheckError `api_auth_failed` when Hawk rejects the account.
   */
  ensureSession(signal: AbortSignal): Promise<void>;
  /**
   * Reads the integration token of a project.
   * @param projectId 24-character hex id of the project.
   * @param signal Deadline of the caller.
   * @returns Integration token as Hawk stores it.
   */
  projectToken(projectId: string, signal: AbortSignal): Promise<string>;
  /**
   * Finds the workspace that holds the project.
   * @param projectId 24-character hex id of the project.
   * @param signal Deadline of the caller.
   * @returns Block flag, limit and counter of the workspace.
   * @throws CheckError `api_forbidden` when no workspace holds the project, `api_error` when it has no plan.
   */
  workspaceQuota(projectId: string, signal: AbortSignal): Promise<WorkspaceQuota>;
  /**
   * Searches events of the project by a text.
   * @param projectId 24-character hex id of the project.
   * @param search Text looked for in titles and contexts.
   * @param signal Deadline of the caller.
   * @returns Events, one per group, in order of first appearance.
   */
  findEvents(projectId: string, search: string, signal: AbortSignal): Promise<FoundEvent[]>;
  /**
   * Reads one event card.
   * @param projectId 24-character hex id of the project.
   * @param eventId Id of the original event.
   * @param signal Deadline of the caller.
   * @returns The event, or null when it does not exist.
   */
  eventCard(projectId: string, eventId: string, signal: AbortSignal): Promise<EventCard | null>;
  /**
   * Removes an event; an attempt that removed it but timed out counts as done.
   * @param projectId 24-character hex id of the project.
   * @param eventId Id of the original event.
   * @param signal Deadline of the caller.
   * @returns False when Hawk answered that nothing was removed.
   */
  removeEvent(projectId: string, eventId: string, signal: AbortSignal): Promise<boolean>;
  /**
   * Reads the notification rules of a project.
   * @param projectId 24-character hex id of the project.
   * @param signal Deadline of the caller.
   * @returns Rules in Hawk order; a missing channel other than `webhook` reads as disabled.
   * @throws CheckError `api_forbidden` when the project is not visible to the account.
   */
  notificationRules(projectId: string, signal: AbortSignal): Promise<NotificationRule[]>;
  /**
   * Creates a rule. Not repeated, because a repeat would create a second rule.
   * @param input Rule to create.
   * @param signal Deadline of the caller.
   * @returns Id of the new rule.
   */
  createNotificationRule(input: NotificationRuleInput, signal: AbortSignal): Promise<string>;
  /**
   * Replaces a rule as a whole.
   * @param input New content of the rule with its id.
   * @param signal Deadline of the caller.
   * @returns Id of the rule, or null when the rule no longer exists.
   */
  updateNotificationRule(input: NotificationRuleUpdate, signal: AbortSignal): Promise<string | null>;
  /**
   * Deletes a rule; Hawk answers null whether or not it existed.
   * @param projectId Project that owns the rule, 24 hex characters.
   * @param ruleId Rule to delete.
   * @param signal Deadline of the caller.
   * @returns Resolves when Hawk accepted the request.
   */
  deleteNotificationRule(projectId: string, ruleId: string, signal: AbortSignal): Promise<void>;
}

/** Channels of a raw rule: any of them may be null. */
type RawChannels = Partial<Record<'email' | 'slack' | 'loop' | 'telegram' | 'webhook', ChannelSettings | null>>;

/** A rule in a raw answer. */
interface RawRule extends Omit<NotificationRule, 'channels'> {
  /** Channels, possibly with nulls. */
  channels: RawChannels;
}

/** Answer of the NotificationRules query. */
interface NotificationRulesData {
  /** Null when the project is not visible. */
  project: NotificationsProject | null;
}

/** Project part of the NotificationRules answer. */
interface NotificationsProject {
  /** Rules, null when the field is empty. */
  notifications: RawRule[] | null;
}

/** Answer of the mutations that return a rule id. */
interface RuleIdData {
  /** Created rule. */
  createProjectNotificationsRule?: RuleId | null;
  /** Updated rule, null when it is gone. */
  updateProjectNotificationsRule?: RuleId | null;
}

/** A rule reduced to its id. */
interface RuleId {
  /** Rule id. */
  id: string;
}

/** Access and refresh tokens of the session. */
interface Session {
  /** Bearer token. */
  accessToken: string;
  /** Token that swaps for a new pair. */
  refreshToken: string;
}

/** Answer of the Login mutation. */
interface LoginData {
  /** The issued pair. */
  login: Session;
}

/** `data` of `RefreshTokens`. */
interface RefreshData {
  /** The issued pair. */
  refreshTokens: Session;
}

/** Answer of the ProjectToken query. */
interface ProjectTokenData {
  /** Null when the project is unknown. */
  project: ProjectTokenValue | null;
}

/** Answer of the RemoveEvent mutation. */
interface RemoveData {
  /** False when Hawk removed nothing. */
  removeEvent: boolean;
}

/** Token of a project. */
interface ProjectTokenValue {
  /** Integration token. */
  token: string;
}

/** An event in a raw answer. */
interface RawEvent {
  /** Id of the repetition or of the original. */
  id: string;
  /** Id of the original event. */
  originalEventId?: string | null;
  /** Group hash. */
  groupHash: string;
  /** Occurrence count. */
  totalCount: number;
  /** Catcher type. */
  catcherType: string;
  /** Arrival time, in Unix seconds. */
  timestamp?: number | null;
  /** Number of users the event happened to. */
  usersAffected?: number | null;
  /** Title, context and the other fields of the payload. */
  payload: RawPayload;
}

/** Payload of a raw event. */
interface RawPayload {
  /** Title. */
  title: string;
  /** Context, any JSON. */
  context?: unknown;
  /** Event type. */
  type?: string | null;
  /** Release name. */
  release?: string | null;
  /** User of the event. */
  user?: unknown;
  /** Query parameters. */
  get?: unknown;
  /** Stack frames. */
  backtrace?: unknown;
  /** Extra data of the catcher. */
  addons?: unknown;
  /** Breadcrumbs. */
  breadcrumbs?: unknown;
}

/** Answer of the FindEvents query. */
interface FindEventsData {
  /** Null when the project is unknown. */
  project: FindEventsProject | null;
}

/** Project part of the FindEvents answer. */
interface FindEventsProject {
  /** Null when the portion is empty. */
  dailyEventsPortion: DailyPortion | null;
}

/** Portion of daily events. */
interface DailyPortion {
  /** Rows, possibly with nulls. */
  dailyEvents: (DailyRow | null)[] | null;
}

/** One daily row. */
interface DailyRow {
  /** The last repetition of the day. */
  event: RawEvent;
}

/** Answer of the EventCard query. */
interface EventCardData {
  /** Null when the project is unknown. */
  project: EventCardProject | null;
}

/** Project part of the EventCard answer. */
interface EventCardProject {
  /** Null when the event does not exist. */
  event: RawEvent | null;
}

/** Answer of the WorkspaceQuota query. */
interface WorkspaceQuotaData {
  /** Workspaces of the account, possibly with nulls. */
  workspaces: (RawWorkspace | null)[] | null;
}

/** Workspace in a raw answer. */
interface RawWorkspace {
  /** Workspace id. */
  id: string;
  /** Block flag. */
  isBlocked: boolean | null;
  /** Counter of the billing period. */
  billingPeriodEventsCount: number | null;
  /** Plan, null when absent. */
  plan: RawPlan | null;
  /** Requested projects of the workspace. */
  projects: unknown[] | null;
}

/** Plan in a raw answer. */
interface RawPlan {
  /** Events per period. */
  eventsLimit: number;
}

/**
 * Reads a time of Hawk, which is in Unix seconds.
 * @param value Number from the API.
 * @returns Milliseconds; a value above 1e11 is taken to be milliseconds already.
 */
function toMilliseconds(value: number): number {
  return value > MILLISECONDS_THRESHOLD ? value : value * MS_PER_SECOND;
}

/**
 * Converts a raw event.
 * @param event Event of an answer.
 * @returns Event with the original id resolved.
 */
function toFoundEvent(event: RawEvent): FoundEvent {
  return { originalEventId: event.originalEventId ?? event.id,
    groupHash: event.groupHash,
    totalCount: event.totalCount,
    catcherType: event.catcherType,
    title: event.payload.title,
    context: event.payload.context ?? null,
    ...typeof event.timestamp === 'number' ? { timestamp: toMilliseconds(event.timestamp) } : {} };
}

/**
 * Converts a raw event into a card.
 * @param event Event of an answer.
 * @returns Card with the fields of the payload.
 */
function toCard(event: RawEvent): EventCard {
  const { payload } = event;

  return { ...toFoundEvent(event),
    type: payload.type,
    release: payload.release,
    user: payload.user,
    get: payload.get,
    backtrace: payload.backtrace,
    addons: payload.addons,
    breadcrumbs: payload.breadcrumbs,
    usersAffected: event.usersAffected };
}

/**
 * Replaces a missing channel with a disabled one.
 * @param channel Channel of a raw rule.
 * @returns The channel, or a disabled stand-in.
 */
function channelOrOff(channel: ChannelSettings | null | undefined): ChannelSettings {
  return channel ?? { isEnabled: false,
    endpoint: '' };
}

/**
 * Converts a raw rule.
 * @param rule Rule of an answer.
 * @returns Rule whose channels are all set, except `webhook` that stays null.
 */
function toRule(rule: RawRule): NotificationRule {
  const { channels } = rule;

  return { ...rule,
    channels: { email: channelOrOff(channels.email),
      slack: channelOrOff(channels.slack),
      loop: channelOrOff(channels.loop),
      telegram: channelOrOff(channels.telegram),
      webhook: channels.webhook ?? null } };
}

/**
 * Creates the Hawk API client with an in-memory session.
 * @param options Transport and account.
 * @returns The client.
 */
export function createHawkApi(options: HawkApiOptions): HawkApi {
  const { transport, email, password, clock } = options;
  const { attempts, delaysMs } = options.retry;
  let session: Session | undefined;

  const authFailed = (detail: string): CheckError => new CheckError('api_auth_failed', { detail });

  const login = async (signal: AbortSignal): Promise<void> => {
    try {
      const data = await transport.request<LoginData>(LOGIN, { email,
        password }, undefined, signal);

      session = data.login;
    } catch (error) {
      session = undefined;

      if (error instanceof GraphqlFailure) {
        throw authFailed(error.message);
      }

      if (isCheckError(error) && error.errorClass === 'api_query_rejected') {
        throw authFailed(error.facts.detail ?? error.message);
      }

      throw error;
    }
  };

  const refresh = async (current: Session, signal: AbortSignal): Promise<void> => {
    try {
      const data = await transport.request<RefreshData>(REFRESH_TOKENS, { refreshToken: current.refreshToken }, undefined, signal);

      session = data.refreshTokens;
    } catch (error) {
      if (error instanceof GraphqlFailure) {
        await login(signal);

        return;
      }

      throw error;
    }
  };

  const ensureSession = async (signal: AbortSignal): Promise<void> => {
    if (!session) {
      await login(signal);
    }
  };

  const call = async <T>(operation: GraphqlOperation, variables: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<T> => {
    await ensureSession(signal);

    return transport.request<T>(operation, variables, session?.accessToken, signal);
  };

  const authorized = async <T>(operation: GraphqlOperation, variables: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<T> => {
    try {
      return await call<T>(operation, variables, signal);
    } catch (error) {
      if (!(error instanceof GraphqlFailure)) {
        throw error;
      }

      if (error.code === ACCESS_EXPIRED && session) {
        await refresh(session, signal);
      } else if (error.code === UNAUTHENTICATED || error.code === ACCESS_EXPIRED) {
        await login(signal);
      } else {
        throw authFailed(error.message);
      }
    }

    try {
      return await call<T>(operation, variables, signal);
    } catch (error) {
      throw error instanceof GraphqlFailure ? authFailed(error.message) : error;
    }
  };

  const removeOnce = async (projectId: string, eventId: string, signal: AbortSignal): Promise<boolean> => {
    const data = await authorized<RemoveData>(REMOVE_EVENT, { projectId,
      eventId }, signal);

    return data.removeEvent;
  };

  const eventCard = async (projectId: string, eventId: string, signal: AbortSignal): Promise<EventCard | null> => {
    const data = await authorized<EventCardData>(EVENT, { projectId,
      eventId,
      originalEventId: eventId }, signal);

    if (!data.project) {
      throw new CheckError('api_error', { detail: 'project not found' });
    }

    return data.project.event ? toCard(data.project.event) : null;
  };

  const projectToken: HawkApi['projectToken'] = async (projectId, signal) => {
    const data = await authorized<ProjectTokenData>(PROJECT_TOKEN, { projectId }, signal);

    if (!data.project) {
      throw new CheckError('api_error', { detail: 'project not found' });
    }

    return data.project.token;
  };

  const workspaceQuota: HawkApi['workspaceQuota'] = async (projectId, signal) => {
    const data = await authorized<WorkspaceQuotaData>(WORKSPACE_QUOTA, { projectId }, signal);
    const workspace = (data.workspaces ?? []).find(item => item !== null && (item.projects ?? []).length > 0);

    if (!workspace) {
      throw new CheckError('api_forbidden', { projectId,
        detail: 'no workspace of the account holds the project' });
    }

    if (!workspace.plan) {
      throw new CheckError('api_error', { detail: 'workspace has no plan' });
    }

    return { workspaceId: workspace.id,
      isBlocked: workspace.isBlocked ?? false,
      eventsLimit: workspace.plan.eventsLimit,
      eventsCount: workspace.billingPeriodEventsCount ?? 0 };
  };

  const findEvents: HawkApi['findEvents'] = async (projectId, search, signal) => {
    const data = await authorized<FindEventsData>(PROJECT_DAILY_EVENTS, { projectId,
      search }, signal);

    if (!data.project) {
      throw new CheckError('api_error', { detail: 'project not found' });
    }

    const byGroup = new Map<string, FoundEvent>();

    for (const row of data.project.dailyEventsPortion?.dailyEvents ?? []) {
      if (row) {
        const event = toFoundEvent(row.event);
        const known = byGroup.get(event.groupHash);

        if (!known || event.totalCount > known.totalCount) {
          byGroup.set(event.groupHash, event);
        }
      }
    }

    return [...byGroup.values()];
  };

  const notificationRules: HawkApi['notificationRules'] = async (projectId, signal) => {
    const data = await authorized<NotificationRulesData>(NOTIFICATION_RULES, { projectId }, signal);

    if (!data.project) {
      throw new CheckError('api_forbidden', { projectId,
        detail: 'project not found or not visible to the account' });
    }

    return (data.project.notifications ?? []).map(toRule);
  };

  const createNotificationRule: HawkApi['createNotificationRule'] = async (input, signal) => {
    const data = await authorized<RuleIdData>(CREATE_NOTIFICATION_RULE, { input }, signal);

    if (!data.createProjectNotificationsRule) {
      throw new CheckError('api_error', { detail: 'create answered without a rule' });
    }

    return data.createProjectNotificationsRule.id;
  };

  const updateNotificationRule: HawkApi['updateNotificationRule'] = async (input, signal) => {
    const data = await authorized<RuleIdData>(UPDATE_NOTIFICATION_RULE, { input }, signal);

    return data.updateProjectNotificationsRule?.id ?? null;
  };

  const deleteNotificationRule: HawkApi['deleteNotificationRule'] = async (projectId, ruleId, signal) => {
    await authorized<unknown>(DELETE_NOTIFICATION_RULE, { input: { projectId,
      ruleId } }, signal);
  };

  const removeEvent: HawkApi['removeEvent'] = async (projectId, eventId, signal) => {
    let failedBefore = false;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await removeOnce(projectId, eventId, signal);
      } catch (error) {
        if (!isCheckError(error)) {
          throw error;
        }

        const vanished = error.errorClass === 'api_error' && failedBefore
          && (error.facts.detail ?? '').startsWith(NOT_FOUND_PREFIX);

        if (vanished && await eventCard(projectId, eventId, signal) === null) {
          return true;
        }

        if (!RETRYABLE_CLASSES.has(error.errorClass) || attempt >= attempts || signal.aborted) {
          throw error;
        }

        failedBefore = true;

        try {
          await clock.sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0, signal);
        } catch {
          throw error;
        }
      }
    }
  };

  return {
    ensureSession,
    eventCard,
    projectToken,
    workspaceQuota,
    findEvents,
    notificationRules,
    createNotificationRule,
    updateNotificationRule,
    deleteNotificationRule,
    removeEvent,
  };
}
