import { formatDuration } from '../../time/format.js';
import type { CollectorClient, CollectorMessage, SendOutcome } from '../../clients/collector.js';
import type { EventCard, FoundEvent, HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import { pollUntil } from '../../engine/poll.js';
import type { PollResult } from '../../engine/poll.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { DegradedCode } from '../../storage/types.js';
import type { Clock } from '../../time/clock.js';
import type { RunPlan } from './plan.js';

const LOW_QUOTA_SHARE = 0.1;
const SENTINEL = 'e2e-sentinel';
// A fixed time keeps every copy of the event equal, so a repeat is compared with the same expected fields.
const BREADCRUMB_START_MS = 1_700_000_000_000;
const BREADCRUMB_GAP_MS = 1000;

/** Browser string the event carries, so the JavaScript worker has something to describe. */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** What the grouper and the API keep of an event; a value over a limit comes back cut, so the monitor stays within them. */
export const EVENT_LIMITS = {
  /** Longest title. */
  title: 400,
  /** Longest string in `context`, `addons` and breadcrumbs. */
  string: 200,
  /** Most keys of one object in `context` and `addons`. */
  keys: 20,
  /** Most items of one array in `context` and `addons`. */
  items: 10,
  /** Deepest nesting of objects and arrays in `context` and `addons`. */
  depth: 5,
  /** Most source lines of one frame. */
  sourceLines: 21,
  /** Longest source line. */
  sourceLine: 140,
} as const;

// The loop sender fails on an event without a backtrace.
const BACKTRACE = [
  { file: 'hawk-e2e-monitor/check.js',
    line: 30,
    column: 5,
    function: 'check',
    arguments: ['runId'],
    sourceCode: [
      { line: 29,
        content: 'function check(runId) {' },
      { line: 30,
        content: '  throw new E2eMonitorCheck(runId);' },
      { line: 31,
        content: '}' },
    ] },
  { file: 'hawk-e2e-monitor/run.js',
    line: 12,
    column: 3,
    function: 'run',
    arguments: ['check'],
    sourceCode: [
      { line: 11,
        content: 'async function run() {' },
      { line: 12,
        content: '  check(runId);' },
      { line: 13,
        content: '}' },
    ] },
  { file: 'hawk-e2e-monitor/main.js',
    line: 4,
    column: 1,
    function: 'main',
    arguments: ['run'],
    sourceCode: [
      { line: 3,
        content: 'const runId = nextRun();' },
      { line: 4,
        content: 'run();' },
      { line: 5,
        content: 'export {};' },
    ] },
];
const BREADCRUMBS = [
  { timestamp: BREADCRUMB_START_MS,
    type: 'default',
    category: 'e2e',
    message: 'run started',
    level: 'info' },
  { timestamp: BREADCRUMB_START_MS + BREADCRUMB_GAP_MS,
    type: 'logic',
    category: 'e2e',
    message: 'event built',
    level: 'debug' },
];

/** What the stages learn on the way and hand to later stages and the verdict. */
export interface ScenarioState {
  /** Outcome of the first send. */
  sendOutcome?: SendOutcome;
  /** True when the event may have reached the collector although no answer confirmed it. */
  sendMayHaveReached: boolean;
  /** Monotonic time of the collector's answer, or of the start of the send when it is uncertain. */
  acceptedAtMs?: number;
  /** Outcome of the second send. */
  repeatOutcome?: SendOutcome;
  /** Monotonic time of the collector's answer to the second send, or of the start of that send when it is uncertain. */
  repeatAcceptedAtMs?: number;
  /** The event found in Hawk. */
  event?: FoundEvent;
  /** Time from `acceptedAtMs` to the first sighting. */
  latencyMs?: number;
  /** How the poll of stage 4 ended. */
  pollSummary?: PollResult<FoundEvent>;
}

/** Everything a stage needs. */
export interface ScenarioContext {
  /** Validated configuration. */
  config: Config;
  /** Decisions made before the run. */
  plan: RunPlan;
  /** Collector client. */
  collector: CollectorClient;
  /** Hawk API client. */
  api: HawkApi;
  /** Time source. */
  clock: Clock;
  /** Shared state of the run. */
  state: ScenarioState;
  /** Poll schedule override, for tests. */
  pollScheduleMs?: readonly number[];
  /** What the event of the scenario looks like; the event of `send-and-receive-event` when absent. */
  eventShape?: EventShape;
}

/** What the shared stages need to know about the event of a scenario. */
export interface EventShape {
  /** Project the event is sent to and looked for in. */
  projectId: string;
  /**
   * Builds the message the collector gets.
   * @param context Scenario context.
   * @returns Message with the token of the project.
   */
  message(context: ScenarioContext): CollectorMessage;
  /**
   * Tells whether a search hit is the event of this run.
   * @param event Event the search returned.
   * @returns True for the event of the run.
   */
  matches(event: FoundEvent): boolean;
  /**
   * Compares the card with what was sent.
   * @param card Event card from the API.
   * @param expectedCount How many times the event must have been counted.
   * @returns The first difference, or undefined.
   */
  check(card: EventCard, expectedCount: number): CheckError | undefined;
  /**
   * Tells whether an event may be removed by this run.
   * @param event Event from the API.
   * @returns True for our event.
   */
  isOurs(event: FoundEvent): boolean;
}

/** What the two availability stages need, so a scenario without an event can run them too. */
export type AvailabilityContext = Pick<ScenarioContext, 'api' | 'collector' | 'config'>;

/**
 * Builds the message of the test event.
 * @param context Scenario context.
 * @returns Message for the collector client.
 */
export function eventMessage(context: ScenarioContext): CollectorMessage {
  const { plan, config } = context;

  return { token: config.hawk.integrationToken,
    catcherType: plan.catcherType,
    payload: { title: plan.title,
      type: 'E2eMonitorCheck',
      backtrace: BACKTRACE,
      user: { id: `e2e-${config.instanceId}`,
        name: 'e2e monitor' },
      addons: { userAgent: BROWSER_USER_AGENT,
        token: SENTINEL },
      breadcrumbs: BREADCRUMBS,
      get: { e2e: plan.runId },
      release: `e2e-${config.instanceId}-plain`,
      context: { ...plan.context,
        password: SENTINEL } } };
}

/**
 * Looks for a string over the limit or a structure too wide or too deep.
 * @param value Value of `context`, `addons` or a breadcrumb.
 * @param path Name of the value for the text.
 * @param depth Nesting above the value, counted as the sanitizer of Hawk counts it.
 * @returns Text of the first violation, or undefined.
 */
function overLimit(value: unknown, path: string, depth: number): string | undefined {
  if (typeof value === 'string') {
    return value.length > EVENT_LIMITS.string ? `${path} is longer than ${String(EVENT_LIMITS.string)} characters` : undefined;
  }

  if (Array.isArray(value)) {
    if (value.length > EVENT_LIMITS.items) {
      return `${path} has more than ${String(EVENT_LIMITS.items)} items`;
    }

    return value.map((item, index) => overLimit(item, `${path}[${String(index)}]`, depth + 1)).find(text => text !== undefined);
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);

    if (depth + 1 > EVENT_LIMITS.depth) {
      return `${path} is nested deeper than ${String(EVENT_LIMITS.depth)} levels (depth)`;
    }

    if (entries.length > EVENT_LIMITS.keys) {
      return `${path} has more than ${String(EVENT_LIMITS.keys)} keys`;
    }

    return entries.map(([key, item]) => overLimit(item, `${path}.${key}`, depth + 1)).find(text => text !== undefined);
  }

  return undefined;
}

/**
 * Checks that an event stays within what Hawk keeps, so what the API shows can be compared with what was sent.
 * @param payload Event as the collector gets it.
 * @returns Text of the first value over a limit, or undefined when all fit.
 */
export function withinEventLimits(payload: Readonly<Record<string, unknown>>): string | undefined {
  const { title, backtrace, breadcrumbs } = payload;

  if (typeof title === 'string' && title.length > EVENT_LIMITS.title) {
    return `title is longer than ${String(EVENT_LIMITS.title)} characters`;
  }

  for (const field of ['context', 'addons'] as const) {
    const text = overLimit(payload[field], field, 0);

    if (text !== undefined) {
      return text;
    }
  }

  const crumbs = Array.isArray(breadcrumbs) ? breadcrumbs as Array<Record<string, unknown>> : [];

  for (const [index, crumb] of crumbs.entries()) {
    const text = overLimit(crumb.message, `breadcrumbs[${String(index)}].message`, 0);

    if (text !== undefined) {
      return text;
    }
  }

  const frames = Array.isArray(backtrace) ? backtrace as Array<Record<string, unknown>> : [];

  for (const [index, frame] of frames.entries()) {
    const lines = Array.isArray(frame.sourceCode) ? frame.sourceCode as Array<Record<string, unknown>> : [];

    if (lines.length > EVENT_LIMITS.sourceLines) {
      return `backtrace[${String(index)}].sourceCode has more than ${String(EVENT_LIMITS.sourceLines)} lines`;
    }

    if (lines.some(line => typeof line.content === 'string' && line.content.length > EVENT_LIMITS.sourceLine)) {
      return `backtrace[${String(index)}].sourceCode has a line longer than ${String(EVENT_LIMITS.sourceLine)} characters`;
    }
  }

  return undefined;
}

/**
 * Stage 1: the collector answers `/health` and rejects an unknown token over WebSocket.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAvailabilityStage(timeoutMs: number): StageSpec<AvailabilityContext> {
  return {
    name: 'collector_availability',
    timeoutMs,
    run: async ({ collector }, signal) => {
      await collector.health(signal);
      await collector.probeInvalidToken(signal);

      return { status: 'ok' };
    },
  };
}

/** What `apiAvailabilityStage` may check besides the token and the quota. */
export interface ApiAvailabilityOptions {
  /** Title of the next event; a grouping pattern that catches it is reported. */
  title?: string;
}

/** What the grouping patterns of a project say about a title. */
interface PatternFindings {
  /** Texts for the result. */
  warnings: string[];
  /** Degradation codes the warnings stand for. */
  degraded: DegradedCode[];
}

/**
 * Names the grouping patterns that catch a title.
 * @param patterns Pattern texts of the project.
 * @param title Title of the next event.
 * @returns Warnings and the codes they stand for.
 */
function patternFindings(patterns: readonly string[], title: string): PatternFindings {
  const warnings: string[] = [];
  let catches = false;

  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'u').test(title)) {
        catches = true;
        warnings.push(`The event grouping pattern "${pattern}" of the project catches the title of the monitor's events, so Hawk may glue them together`);
      }
    } catch {
      warnings.push(`The event grouping pattern "${pattern}" of the project is not a regular expression the monitor can read`);
    }
  }

  return { warnings,
    degraded: catches ? ['grouping_pattern'] : [] };
}

/**
 * Stage 2: the monitor can sign in, the token belongs to the project, the workspace has quota and no grouping pattern catches the next title.
 * @param timeoutMs Time limit of the stage.
 * @param options Title of the next event, for the pattern check.
 * @returns Stage spec.
 */
export function apiAvailabilityStage(timeoutMs: number, options: ApiAvailabilityOptions = {}): StageSpec<AvailabilityContext> {
  return {
    name: 'api_availability',
    timeoutMs,
    run: async ({ api, config }, signal): Promise<StageOutcome> => {
      const { projectId, integrationToken } = config.hawk;

      await api.ensureSession(signal);

      const info = await api.projectInfo(projectId, signal);
      const hawkToken = decodeIntegrationToken(info.token);
      const ownToken = decodeIntegrationToken(integrationToken);

      if (hawkToken === undefined || ownToken === undefined || tokenKey(hawkToken) !== tokenKey(ownToken)) {
        throw new CheckError('token_mismatch');
      }

      const quota = await api.workspaceQuota(projectId, signal);
      const usage = `${String(quota.eventsCount)}/${String(quota.eventsLimit)}`;

      if (quota.isBlocked) {
        throw new CheckError('workspace_blocked', { detail: usage });
      }

      if (quota.eventsCount >= quota.eventsLimit) {
        throw new CheckError('quota_exhausted', { detail: usage });
      }

      const left = (quota.eventsLimit - quota.eventsCount) / quota.eventsLimit;
      const findings = options.title === undefined
        ? { warnings: [],
            degraded: [] }
        : patternFindings(info.groupingPatterns, options.title);
      const details: Record<string, unknown> = { quota: { eventsCount: quota.eventsCount,
        eventsLimit: quota.eventsLimit } };

      if (left < LOW_QUOTA_SHARE) {
        details.warning = `Event quota is almost used: ${usage}`;
        details.quotaLow = true;
      }

      if (findings.warnings.length > 0) {
        details.warnings = findings.warnings;
      }

      if (findings.degraded.length > 0) {
        details.degraded = findings.degraded;
      }

      return { status: 'ok',
        details };
    },
  };
}
/**
 * Reads a key of an event context.
 * @param context Context as the API returns it.
 * @param key Key to read.
 * @returns The value, or undefined when the context is not an object.
 */
function contextValue(context: unknown, key: string): unknown {
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Prints a compared value for an error text.
 * @param value Anything.
 * @returns The string itself or its JSON.
 */
function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
}

/**
 * Compares the event Hawk shows with the one we sent.
 * @param event Event from the API.
 * @param plan Plan of the run.
 * @param expectedCount How many times the event must have been counted.
 * @returns The first difference as an error: fields in the order title, context, catcher type, count.
 */
export function checkEventFields(event: FoundEvent, plan: RunPlan, expectedCount: number): CheckError | undefined {
  const fields: Array<[string, unknown, string]> = [
    ['title', event.title, plan.title],
    ['context.runId', contextValue(event.context, 'runId'), plan.runId],
    ['context.instanceId', contextValue(event.context, 'instanceId'), plan.context.instanceId],
    ['catcherType', event.catcherType, plan.catcherType],
  ];

  for (const [field, actual, expected] of fields) {
    if (actual !== expected) {
      return new CheckError('event_mismatch', { field,
        expected,
        actual: show(actual) });
    }
  }

  if (event.totalCount > expectedCount) {
    return new CheckError('duplicate_event', { count: event.totalCount });
  }

  if (event.totalCount < expectedCount) {
    return new CheckError('event_mismatch', { field: 'totalCount',
      expected: String(expectedCount),
      actual: String(event.totalCount) });
  }

  return undefined;
}

const FILTERED = '[filtered]';
const MASKED_FIELDS: ReadonlySet<string> = new Set(['context.password', 'addons.token']);

/**
 * Lists the values the event was sent with, as the names the card shows them under.
 * @param payload Payload that was sent.
 * @returns Name and value pairs in a fixed order.
 */
function sentFields(payload: Readonly<Record<string, unknown>>): Array<[string, unknown]> {
  const fields: Array<[string, unknown]> = [['type', payload.type], ['release', payload.release]];

  for (const group of ['user', 'get', 'context', 'addons'] as const) {
    for (const [key, value] of Object.entries(payload[group] as Record<string, unknown>)) {
      fields.push([`${group}.${key}`, value]);
    }
  }

  for (const [group, items] of [['breadcrumbs', payload.breadcrumbs], ['backtrace', payload.backtrace]] as const) {
    for (const [index, item] of (items as Array<Record<string, unknown>>).entries()) {
      for (const [key, value] of Object.entries(item)) {
        fields.push([`${group}[${String(index)}].${key}`, value]);
      }
    }
  }

  return fields;
}

/**
 * Reads the value a name points to on the card.
 * @param card Event card.
 * @param name Name from `sentFields`, such as `backtrace[1].line` or `user.id`.
 * @returns The value, undefined when the card has none.
 */
function valueAt(card: EventCard, name: string): unknown {
  let value: unknown = card;

  for (const step of name.split(/[.[\]]+/u).filter(part => part !== '')) {
    value = typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[step] : undefined;
  }

  return value;
}

/**
 * Compares the card Garage shows with the event that was sent, field by field.
 * Values the grouper must mask are expected as `[filtered]`.
 * @param card Event card from the API.
 * @param sent Payload that was sent.
 * @param plan Plan of the run.
 * @param expectedCount How many times the event must have been counted.
 * @returns The first difference as an error, naming the field; undefined when the card matches.
 */
export function checkCard(card: EventCard, sent: Readonly<Record<string, unknown>>, plan: RunPlan, expectedCount: number): CheckError | undefined {
  const basic = checkEventFields(card, plan, expectedCount);

  if (basic) {
    return basic;
  }

  for (const [field, value] of sentFields(sent)) {
    const actual = valueAt(card, field);
    const expected = MASKED_FIELDS.has(field) ? FILTERED : value;

    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      return MASKED_FIELDS.has(field) && JSON.stringify(actual) === JSON.stringify(value)
        ? new CheckError('field_not_masked', { field,
          actual: show(actual) })
        : new CheckError('event_mismatch', { field,
          expected: show(expected),
          actual: show(actual) });
    }
  }

  if (plan.catcherType !== 'errors/javascript' && valueAt(card, 'addons.beautifiedUserAgent') !== undefined) {
    return new CheckError('event_mismatch', { field: 'addons.beautifiedUserAgent' }, { message: 'Event has an unexpected field beautifiedUserAgent: only a JavaScript event is described by the JavaScript worker' });
  }

  if (card.usersAffected !== 1) {
    return new CheckError('event_mismatch', { field: 'usersAffected',
      expected: '1',
      actual: show(card.usersAffected) });
  }

  return undefined;
}

/**
 * Tells whether an event is the one this run sent, so it may be removed.
 * Either the title carries our prefix, or the context names this run and this instance.
 * @param event Event from the API.
 * @param plan Plan of the run.
 * @param instanceId Id of this monitor.
 * @returns True for our event.
 */
export function isOurEvent(event: FoundEvent, plan: RunPlan, instanceId: string): boolean {
  return event.title.startsWith(`[e2e:${instanceId}] ${plan.runId} `)
    || (contextValue(event.context, 'runId') === plan.runId && contextValue(event.context, 'instanceId') === instanceId);
}

/**
 * Builds the shape of the event of `send-and-receive-event`, which `check-notification` shares.
 * @param context Scenario context with the plan and the configuration.
 * @returns Shape whose project is the monitored one.
 */
export function sendEventShape(context: ScenarioContext): EventShape {
  const { plan, config } = context;

  return {
    projectId: config.hawk.projectId,
    message: eventMessage,
    matches: event => event.title === plan.title || contextValue(event.context, 'runId') === plan.runId,
    check: (card, expectedCount) => checkCard(card, eventMessage(context).payload, plan, expectedCount),
    isOurs: event => isOurEvent(event, plan, config.instanceId),
  };
}

/**
 * Picks the shape the context names, or the default one.
 * @param context Scenario context.
 * @returns Shape of the event.
 */
function shapeOf(context: ScenarioContext): EventShape {
  return context.eventShape ?? sendEventShape(context);
}

/**
 * Stage 3: sends the event over the planned transport.
 * @param timeoutMs Time limit of the stage.
 * @param beforeSend Called right before the first send, for what must be in place before the event leaves.
 * @returns Stage spec.
 */
export function collectorAcceptStage(timeoutMs: number, beforeSend?: () => void): StageSpec<ScenarioContext> {
  return {
    name: 'collector_accept',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { collector, clock, plan, state } = context;

      beforeSend?.();

      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(shapeOf(context).message(context), plan.transport, signal);

      state.sendOutcome = outcome;

      switch (outcome.kind) {
        case 'accepted':
          state.acceptedAtMs = clock.monotonicMs();

          return { status: 'ok',
            details: { attempts: outcome.attempts } };
        case 'uncertain':
          state.sendMayHaveReached = true;
          state.acceptedAtMs = startedMs;

          return { status: 'uncertain',
            error: outcome.cause,
            details: { attempts: outcome.attempts,
              warning: `The collector did not confirm the event (${outcome.cause.message}); SDKs of users may see an error` } };
        case 'rejected':
          return { status: 'failed',
            error: outcome.error,
            details: { attempts: outcome.attempts } };
      }
    },
  };
}

/**
 * Tells whether a JavaScript event that carries a user agent came back without the description the JavaScript worker adds.
 * @param card Event card from the API.
 * @param sent Payload that was sent.
 * @returns True when the worker left no trace.
 */
function workerMissing(card: EventCard, sent: Readonly<Record<string, unknown>>): boolean {
  const addons = sent.addons as Record<string, unknown> | undefined;

  return card.catcherType === 'errors/javascript' && typeof addons?.userAgent === 'string'
    && valueAt(card, 'addons.beautifiedUserAgent') === undefined;
}

/**
 * Stage 4: waits until the event is visible in the API and checks its fields.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function eventVisibleStage(timeoutMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'event_visible',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, config, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;
      // The search leaves one HTTP timeout of the stage for the card read, which keeps the stage signal.
      const search = new AbortController();
      const timer = new AbortController();
      const onStageAbort = (): void => {
        search.abort();
      };

      if (signal.aborted) {
        onStageAbort();
      } else {
        signal.addEventListener('abort', onStageAbort, { once: true });
      }

      clock.sleep(Math.max(timeoutMs - config.httpTimeoutMs, 0), timer.signal).then(onStageAbort, () => undefined);

      let poll;

      try {
        poll = await pollUntil<FoundEvent>(async (probeSignal) => {
          const events = await api.findEvents(projectId, plan.runId, probeSignal);
          const hit = events.find(event => shape.matches(event));

          return hit
            ? { kind: 'found',
                value: hit }
            : { kind: 'absent' };
        }, { clock,
          signal: search.signal,
          scheduleMs: context.pollScheduleMs });
      } finally {
        timer.abort();
        signal.removeEventListener('abort', onStageAbort);
      }

      state.pollSummary = poll;

      if (poll.outcome === 'not_found') {
        const now = clock.monotonicMs();
        const waitedMs = Math.round(now - poll.startedAtMs);

        return { status: 'failed',
          error: new CheckError('event_not_found', { waitedMs,
            successes: poll.successes,
            errors: poll.errors,
            lastSuccessAgoMs: Math.round(now - poll.lastSuccessAtMs) }),
          details: { pollOutcome: 'not_found',
            waitedMs,
            successes: poll.successes,
            errors: poll.errors } };
      }

      if (poll.outcome === 'api_error') {
        return { status: 'failed',
          error: poll.lastError,
          details: { pollOutcome: 'api_error',
            waitedMs: Math.round(clock.monotonicMs() - poll.startedAtMs),
            errors: poll.errors } };
      }

      state.event = poll.value;

      if (state.acceptedAtMs !== undefined) {
        state.latencyMs = poll.foundAtMs - state.acceptedAtMs;
      }

      const card = await api.eventCard(projectId, poll.value.originalEventId, signal);

      if (card === null) {
        throw new CheckError('event_mismatch', { field: 'event',
          expected: 'present',
          actual: 'missing' });
      }

      state.event = card;

      const mismatch = shape.check(card, 1);

      if (mismatch) {
        throw mismatch;
      }

      const details: Record<string, unknown> = { pollOutcome: 'found',
        attempts: poll.attempts,
        errors: poll.errors };

      if (workerMissing(card, shape.message(context).payload)) {
        details.degraded = ['js_worker_not_seen'];
        details.warning = 'The JavaScript event has no beautifiedUserAgent: the JavaScript worker did not handle it, or Hawk routes JavaScript events elsewhere';
      }

      return { status: 'ok',
        details };
    },
  };
}

/**
 * Stage 5: sends the event again and waits until Hawk counts it twice.
 * @param timeoutMs Time limit of the stage.
 * @param beforeSend Called right before the second send, for what must be known before the repeat leaves.
 * @returns Stage spec.
 */
export function eventRepeatedStage(timeoutMs: number, beforeSend?: () => void): StageSpec<ScenarioContext> {
  return {
    name: 'event_repeated',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, collector, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;

      if (!plan.repeat) {
        return { status: 'skipped' };
      }

      const first = state.event;

      if (first === undefined) {
        throw new CheckError('monitor_internal', { detail: 'event_repeated ran without a found event' });
      }

      beforeSend?.();

      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(shape.message(context), plan.transport, signal);

      state.repeatOutcome = outcome;
      state.repeatAcceptedAtMs = outcome.kind === 'accepted' ? clock.monotonicMs() : startedMs;

      if (outcome.kind === 'rejected') {
        return { status: 'failed',
          error: outcome.error,
          details: { attempts: outcome.attempts } };
      }

      let lastCount = 1;
      const poll = await pollUntil<EventCard>(async (probeSignal) => {
        const card = await api.eventCard(projectId, first.originalEventId, probeSignal);

        if (card === null) {
          return { kind: 'absent' };
        }

        lastCount = card.totalCount;

        return card.totalCount >= 2
          ? { kind: 'found',
              value: card }
          : { kind: 'absent' };
      }, { clock,
        signal,
        scheduleMs: context.pollScheduleMs });

      if (poll.outcome === 'found') {
        state.event = poll.value;

        const duplicate = shape.check(poll.value, 2);

        return duplicate
          ? { status: 'failed',
              error: duplicate,
              details: { pollOutcome: 'found' } }
          : { status: 'ok',
              details: { pollOutcome: 'found',
                attempts: poll.attempts,
                repeatUncertain: outcome.kind === 'uncertain',
                ...outcome.kind === 'uncertain'
                  ? { warning: `The collector did not confirm the repeated event (${outcome.cause.message}); SDKs of users may see an error` }
                  : {} } };
      }

      const waitedMs = Math.round(clock.monotonicMs() - poll.startedAtMs);
      const uncertain = outcome.kind === 'uncertain' ? outcome.cause : undefined;

      if (poll.outcome === 'api_error') {
        const suffix = '; the repeated event was not confirmed by the collector either';

        return { status: 'failed',
          error: uncertain
            ? new CheckError(poll.lastError.errorClass, poll.lastError.facts, { message: `${poll.lastError.message}${suffix}` })
            : poll.lastError,
          details: { pollOutcome: 'api_error',
            waitedMs,
            errors: poll.errors } };
      }

      return { status: 'failed',
        error: uncertain
          ? new CheckError(uncertain.errorClass, uncertain.facts, { message: `Collector did not confirm the repeated event (${uncertain.message}); it was not counted twice within ${formatDuration(waitedMs)}` })
          : new CheckError('repeat_not_counted', { count: lastCount,
            waitedMs }),
        details: { pollOutcome: 'not_found',
          waitedMs,
          successes: poll.successes,
          errors: poll.errors } };
    },
  };
}

/**
 * Wraps a failure of a cleanup call into `cleanup_failed`.
 * @param error What the call threw.
 * @returns Error of class `cleanup_failed`, or the input when it is not a check error.
 */
function cleanupFailure(error: unknown): unknown {
  return error instanceof CheckError
    ? new CheckError('cleanup_failed', { detail: error.message }, { cause: error })
    : error;
}

/**
 * Stage 6: removes the test event when it is ours.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function cleanupStage(timeoutMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'cleanup',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, config, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;
      const refuse = (event: FoundEvent): CheckError => new CheckError('cleanup_refused', { detail: `"${event.title}" (${event.originalEventId})` });
      const details: Record<string, unknown> = {};
      let target = state.event;

      if (target === undefined) {
        // An accepted event may still be on its way through the workers, so look for it too.
        if (!state.sendMayHaveReached && state.sendOutcome?.kind !== 'accepted') {
          return { status: 'skipped' };
        }

        let found: FoundEvent[];

        try {
          found = await api.findEvents(projectId, plan.runId, signal);
        } catch (error) {
          throw cleanupFailure(error);
        }

        const [first] = found;

        if (first === undefined) {
          return { status: 'skipped',
            details: { found: false } };
        }

        target = found.find(event => shape.isOurs(event));

        if (target === undefined) {
          throw refuse(first);
        }

        // The event outran stage 4's deadline; leave a trace so the late arrival is visible in the result.
        details.foundBySearch = true;
        details.originalEventId = target.originalEventId;
      } else {
        if (!shape.isOurs(target)) {
          throw refuse(target);
        }

        // A worker may count one more copy after the check, so wait a little before the recheck.
        // The verdict reads the count from `details`.
        let cut = false;

        if (config.lateDuplicateWaitMs > 0) {
          try {
            await clock.sleep(config.lateDuplicateWaitMs, signal);
          } catch {
            cut = true;
          }
        }

        if (cut) {
          // The timeout ran out during the pause; removal still gets its try.
          details.recheck = 'skipped';
          details.warning = 'The event count was not rechecked: the cleanup time limit cut the wait';
        } else {
          // The read gets one HTTP timeout of its own, so retries inside the transport cannot eat the time the removal needs.
          const recheck = new AbortController();
          const timer = new AbortController();
          const onStageAbort = (): void => {
            recheck.abort();
          };

          if (signal.aborted) {
            onStageAbort();
          } else {
            signal.addEventListener('abort', onStageAbort, { once: true });
          }

          clock.sleep(config.httpTimeoutMs, timer.signal).then(onStageAbort, () => undefined);

          try {
            const card = await api.eventCard(projectId, target.originalEventId, recheck.signal);

            if (card === null) {
              details.recheck = 'missing';
            } else if (card.totalCount > target.totalCount) {
              details.lateTotalCount = card.totalCount;
            }
          } catch (error) {
            if (!(error instanceof CheckError)) {
              throw error;
            }

            details.recheck = 'failed';
            details.warning = `The event count could not be rechecked before cleanup: ${error.message}`;
          } finally {
            timer.abort();
            signal.removeEventListener('abort', onStageAbort);
          }
        }
      }

      const withDetails = (outcome: StageOutcome): StageOutcome => Object.keys(details).length > 0
        ? { ...outcome,
            details }
        : outcome;
      let removed: boolean;

      try {
        removed = await api.removeEvent(projectId, target.originalEventId, signal);
      } catch (error) {
        const failure = cleanupFailure(error);

        if (!(failure instanceof CheckError)) {
          throw failure;
        }

        return withDetails({ status: 'failed',
          error: failure });
      }

      if (!removed) {
        return withDetails({ status: 'failed',
          error: new CheckError('cleanup_failed', { detail: 'Hawk answered that nothing was removed' }) });
      }

      if (details.foundBySearch === true) {
        details.warning = 'The event appeared only after the event_visible deadline and was removed by cleanup';
      }

      return withDetails({ status: 'ok' });
    },
  };
}
