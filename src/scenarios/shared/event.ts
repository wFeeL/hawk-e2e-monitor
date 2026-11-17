import type { CollectorMessage } from '../../clients/collector.js';
import type { EventCard, FoundEvent } from '../../clients/hawk-api.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { RunPlan } from './plan.js';
import type { ScenarioContext } from './context.js';

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
 * Tells whether a value is what the JavaScript worker writes for a user agent.
 * @param value Value of `addons.beautifiedUserAgent`.
 * @returns True for an object with string `os`, `osVersion`, `browser` and `browserVersion`.
 */
function hasBrowserDetails(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && ['os', 'osVersion', 'browser', 'browserVersion'].every(key => typeof (value as Record<string, unknown>)[key] === 'string');
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

  const described = valueAt(card, 'addons.beautifiedUserAgent');

  if (described !== undefined && !hasBrowserDetails(described)) {
    return new CheckError('event_mismatch', { field: 'addons.beautifiedUserAgent',
      expected: 'object with string os, osVersion, browser and browserVersion',
      actual: show(described) });
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
export function shapeOf(context: ScenarioContext): EventShape {
  return context.eventShape ?? sendEventShape(context);
}

/**
 * Tells whether a JavaScript event that carries a user agent came back without the description the JavaScript worker adds.
 * @param card Event card from the API.
 * @param sent Payload that was sent.
 * @returns True when the worker left no trace.
 */
export function workerMissing(card: EventCard, sent: Readonly<Record<string, unknown>>): boolean {
  const addons = sent.addons as Record<string, unknown> | undefined;

  return card.catcherType === 'errors/javascript' && typeof addons?.userAgent === 'string'
    && valueAt(card, 'addons.beautifiedUserAgent') === undefined;
}
