import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventCard, FoundEvent, HawkApi } from '../../../src/clients/hawk-api.js';
import { runStage } from '../../../src/engine/stages.js';
import type { StageResult } from '../../../src/engine/result.js';
import type { StageSpec } from '../../../src/engine/stages.js';
import { systemClock } from '../../../src/time/clock.js';
import { encodeToken, startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { testConfig } from '../../support/config.js';
import { createFakeClock } from '../../support/fake-clock.js';
import { TIMEOUT_LIMITS, createTestScenario } from '../../support/scenario.js';
import type { TestScenarioOptions } from '../../support/scenario.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { groom } from '../../support/fake-hawk/grouper.js';
import { planRun } from '../../../src/scenarios/send-and-receive/plan.js';
import { apiAvailabilityStage, BROWSER_USER_AGENT, EVENT_LIMITS, checkCard, checkEventFields, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventMessage, eventVisibleStage, isOurEvent, sendEventShape, withinEventLimits } from '../../../src/scenarios/send-and-receive/stages.js';
import type { ScenarioContext } from '../../../src/scenarios/send-and-receive/stages.js';

const TIMEOUT_MS = 2000;
const QUOTA_REFUSAL = JSON.stringify({ code: 402,
  error: true,
  message: 'Project has exceeded the events limit' });

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Runs one stage under the engine, as the scenario does.
 * @param spec Stage to run.
 * @param context Scenario context.
 * @returns Recorded result.
 */
async function run(spec: StageSpec<ScenarioContext>, context: ScenarioContext): Promise<StageResult> {
  return runStage(spec, context, { clock: systemClock,
    runSignal: new AbortController().signal });
}

/**
 * Builds a scenario context on the fake Hawk.
 * @param options Setup overrides.
 * @returns Context.
 */
function scenario(options: TestScenarioOptions = {}): ReturnType<typeof createTestScenario> {
  return createTestScenario(hawk, options);
}

describe('collectorAvailabilityStage', () => {
  it('is ok on a healthy collector', async () => {
    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.status).toBe('ok');
  });

  it('fails with collector_dependency_error when a health flag is false', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'collector_dependency_error',
      culprit: 'hawk' });
  });

  it('fails with collector_unexpected_response when the probe is accepted', async () => {
    hawk.collector.knobs.reply = () => ({ status: 200,
      body: JSON.stringify({ code: 200,
        error: false,
        message: 'OK' }) });

    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.errorClass).toBe('collector_unexpected_response');
  });
});

describe('apiAvailabilityStage grouping patterns', () => {
  it('says nothing when no pattern catches the title', async () => {
    hawk.api.knobs.groupingPatterns = ['^unrelated'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.warnings).toBeUndefined();
    expect(result.details?.degraded).toBeUndefined();
  });

  it('warns and marks the run when a pattern catches the title', async () => {
    const { context, plan } = scenario();

    hawk.api.knobs.groupingPatterns = ['^unrelated', '\\[e2e:.*\\] .* send-and-receive-event'];

    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toEqual(['grouping_pattern']);
    expect((result.details?.warnings as string[]).join(' ')).toContain('\\[e2e:.*\\] .* send-and-receive-event');
  });

  it('reads a pattern as Hawk does, without the u flag, so an escaped colon still works', async () => {
    hawk.api.knobs.groupingPatterns = ['\\[e2e\\:.*'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.details?.degraded).toEqual(['grouping_pattern']);
    expect(JSON.stringify(result.details?.warnings)).not.toContain('not a regular expression');
  });

  it('only warns about a pattern that is not a regular expression', async () => {
    hawk.api.knobs.groupingPatterns = ['(unclosed'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toBeUndefined();
    expect(JSON.stringify(result.details?.warnings)).toContain('(unclosed');
  });

  it('does not look at the patterns without a title', async () => {
    hawk.api.knobs.groupingPatterns = ['.*'];

    expect((await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context)).details?.degraded).toBeUndefined();
  });

  it('keeps the quota warning next to the pattern warning', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };
    hawk.api.knobs.groupingPatterns = ['.*'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.details?.quotaLow).toBe(true);
    expect(result.details?.warning).toContain('quota');
    expect(result.details?.degraded).toEqual(['grouping_pattern']);
  });
});

describe('apiAvailabilityStage', () => {
  it('is ok on a healthy API', async () => {
    const { context } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS), context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBeUndefined();
    expect(result.details?.quotaLow).toBeUndefined();
  });

  it('always records the quota in its details', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 1000,
      billingPeriodEventsCount: 12 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details?.quota).toEqual({ eventsCount: 12,
      eventsLimit: 1000 });
  });

  it('keeps the quota next to the warning', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details).toEqual({ warning: 'Event quota is almost used: 95/100',
      quotaLow: true,
      quota: { eventsCount: 95,
        eventsLimit: 100 } });
  });

  it('token_mismatch when the project has another token', async () => {
    hawk.api.knobs.projectToken = encodeToken('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'token_mismatch',
      culprit: 'config' });
  });

  it('token_mismatch when the API token does not decode', async () => {
    hawk.api.knobs.projectToken = 'not a token';

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.errorClass).toBe('token_mismatch');
  });

  it('workspace_blocked when Hawk blocked the workspace', async () => {
    hawk.api.knobs.workspace = { isBlocked: true,
      eventsLimit: 100,
      billingPeriodEventsCount: 0 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'workspace_blocked',
      culprit: 'monitor' });
  });

  it('quota_exhausted when the counter reaches the limit', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 100 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(result.message).toContain('100/100');
  });

  it('warns when less than 10 percent of the quota is left', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBe('Event quota is almost used: 95/100');
  });

  it('no warning when exactly 10 percent is left', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 90 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details?.warning).toBeUndefined();
  });

  it('api_unavailable when the API is down', async () => {
    hawk.api.knobs.down = true;

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'api_unavailable' });
  });
});

describe('collectorAcceptStage', () => {
  it.each(['http', 'ws'] as const)('is ok over %s and the event reaches the store', async (transport) => {
    const { context, plan } = scenario({ transport });
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result.status).toBe('ok');
    expect(context.state.sendOutcome?.kind).toBe('accepted');
    expect(context.state.acceptedAtMs).toBeTypeOf('number');
    expect(context.state.sendMayHaveReached).toBe(false);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(1);

    const [stored] = hawk.store.all(hawk.projectId);

    expect(stored?.catcherType).toBe(plan.catcherType);
    expect(stored?.payload).toEqual(groom(plan.catcherType, eventMessage(context).payload));
    expect(stored?.payload.title).toBe(plan.title);
    expect((stored?.payload.context as Record<string, unknown>).password).toBe('[filtered]');
  });

  it('calls beforeSend before the event reaches the collector', async () => {
    const { context } = scenario();
    let postsAtHook = -1;
    const result = await run(collectorAcceptStage(TIMEOUT_MS, () => {
      postsAtHook = hawk.collector.posts;
    }), context);

    expect(result.status).toBe('ok');
    expect(postsAtHook).toBe(0);
    expect(hawk.collector.posts).toBe(1);
  });

  it('payload carries three backtrace frames', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const [stored] = hawk.store.all(hawk.projectId);

    expect(stored?.payload.backtrace).toHaveLength(3);
    expect((stored?.payload.backtrace as Array<Record<string, unknown>>)[0]).toMatchObject({ file: 'hawk-e2e-monitor/check.js',
      function: 'check' });
  });

  it('fails with the class of a rejection and does not mark the send as reached', async () => {
    hawk.collector.knobs.reply = () => ({ status: 402,
      body: QUOTA_REFUSAL });

    const { context } = scenario();
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(context.state.sendMayHaveReached).toBe(false);
  });

  it('is uncertain when the answer times out, and sends exactly once', async () => {
    hawk.collector.knobs.replyDelayMs = 300;

    const { context } = scenario({ env: TIMEOUT_LIMITS });
    const before = context.clock.monotonicMs();
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'uncertain',
      errorClass: 'collector_unavailable',
      culprit: 'hawk' });
    expect(context.state.sendMayHaveReached).toBe(true);
    expect(context.state.acceptedAtMs).toBeGreaterThanOrEqual(before);
    expect(context.state.acceptedAtMs).toBeLessThan(before + 50);
    expect(hawk.collector.posts).toBe(1);
  });
});

describe('checkEventFields', () => {
  const plan = planRun(testConfig(), { sequence: 1 }, 'send-and-receive-event');
  const good: FoundEvent = { originalEventId: 'e1',
    groupHash: 'g',
    totalCount: 1,
    catcherType: plan.catcherType,
    title: plan.title,
    context: { runId: plan.runId,
      instanceId: plan.context.instanceId } };

  it('accepts the event we sent', () => {
    expect(checkEventFields(good, plan, 1)).toBeUndefined();
  });

  it.each([
    ['title', { title: 'other' }],
    ['context.runId', { context: { runId: 'x',
      instanceId: plan.context.instanceId } }],
    ['context.instanceId', { context: { runId: plan.runId,
      instanceId: 'x' } }],
    ['catcherType', { catcherType: 'errors/default' }],
  ] as const)('event_mismatch on %s', (field, change) => {
    const error = checkEventFields({ ...good,
      ...change }, plan, 1);

    expect(error?.errorClass).toBe('event_mismatch');
    expect(error?.facts.field).toBe(field);
  });

  it('reports the first differing field in the documented order', () => {
    const error = checkEventFields({ ...good,
      title: 'other',
      catcherType: 'errors/default' }, plan, 1);

    expect(error?.facts.field).toBe('title');
  });

  it('event_mismatch when the context is missing', () => {
    expect(checkEventFields({ ...good,
      context: null }, plan, 1)?.facts.field).toBe('context.runId');
  });

  it('duplicate_event when totalCount is above the expected count', () => {
    const error = checkEventFields({ ...good,
      totalCount: 3 }, plan, 2);

    expect(error?.errorClass).toBe('duplicate_event');
    expect(error?.facts.count).toBe(3);
  });

  it('event_mismatch when totalCount is below the expected count', () => {
    const error = checkEventFields({ ...good,
      totalCount: 0 }, plan, 1);

    expect(error?.errorClass).toBe('event_mismatch');
    expect(error?.facts.field).toBe('totalCount');
  });
});

describe('isOurEvent', () => {
  const plan = planRun(testConfig(), { sequence: 1 }, 'send-and-receive-event');
  const base: FoundEvent = { originalEventId: 'e1',
    groupHash: 'g',
    totalCount: 1,
    catcherType: plan.catcherType,
    title: 'unrelated',
    context: {} };

  it('recognizes the title prefix', () => {
    expect(isOurEvent({ ...base,
      title: plan.title }, plan, plan.context.instanceId)).toBe(true);
  });

  it('recognizes our context when the title is mangled', () => {
    expect(isOurEvent({ ...base,
      context: { runId: plan.runId,
        instanceId: plan.context.instanceId } }, plan, plan.context.instanceId)).toBe(true);
  });

  it('refuses a title of another run or instance', () => {
    expect(isOurEvent({ ...base,
      title: `[e2e:${plan.context.instanceId}] rother send-and-receive-event` }, plan, plan.context.instanceId)).toBe(false);
    expect(isOurEvent({ ...base,
      title: `[e2e:other] ${plan.runId} send-and-receive-event` }, plan, plan.context.instanceId)).toBe(false);
  });

  it('refuses a context with only the run id', () => {
    expect(isOurEvent({ ...base,
      context: { runId: plan.runId } }, plan, plan.context.instanceId)).toBe(false);
  });

  it('refuses a foreign event with an empty context', () => {
    expect(isOurEvent({ ...base,
      title: `foreign ${plan.runId}` }, plan, plan.context.instanceId)).toBe(false);
  });
});

describe('cleanupStage pause', () => {
  it('skips the recheck when the pause is cut by the timeout, and still tries to remove', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const slow: ScenarioContext = { ...context,
      config: { ...context.config,
        lateDuplicateWaitMs: 5000 } };
    const result = await runStage(cleanupStage(100), slow, { clock: systemClock,
      runSignal: new AbortController().signal });

    expect(result.details).toMatchObject({ recheck: 'skipped' });
    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_failed' });
  });
});

describe('event shape', () => {
  it('collectorAcceptStage sends the message of the shape', async () => {
    const { context, plan } = scenario();
    const custom: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        message: base => ({ ...eventMessage(base),
          payload: { ...eventMessage(base).payload,
            title: `${plan.title} shaped` } }) } };

    await run(collectorAcceptStage(TIMEOUT_MS), custom);

    expect(hawk.store.all(hawk.projectId).map(event => event.payload.title)).toEqual([`${plan.title} shaped`]);
  });

  it('eventVisibleStage reads the project, matches and checks through the shape', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const elsewhere: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        projectId: 'c'.repeat(24) } };

    expect(await run(eventVisibleStage(TIMEOUT_MS), elsewhere)).toMatchObject({ status: 'failed',
      errorClass: 'api_forbidden' });

    const blind: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        matches: () => false } };

    // The search stops one HTTP timeout before the deadline, so the stage needs more than that.
    expect(await run(eventVisibleStage(1300), blind)).toMatchObject({ errorClass: 'event_not_found' });

    const strict: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        check: () => new CheckError('event_mismatch', { field: 'shape' }) } };

    expect(await run(eventVisibleStage(TIMEOUT_MS), strict)).toMatchObject({ errorClass: 'event_mismatch' });
  });

  it('cleanupStage asks the shape whether the event is ours', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const refusing: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        isOurs: () => false } };

    expect(await run(cleanupStage(TIMEOUT_MS), refusing)).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_refused' });
    expect(hawk.store.all(hawk.projectId)).toHaveLength(1);
  });

  it('the default shape is the one of send-and-receive-event', () => {
    const { context, plan } = scenario();
    const shape = sendEventShape(context);

    expect(shape.projectId).toBe(context.config.hawk.projectId);
    expect(shape.message(context).payload).toMatchObject({ title: plan.title });
    expect(shape.matches({ originalEventId: 'e',
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      title: plan.title,
      context: {} })).toBe(true);
  });
});

const PAN_PATTERN = /^(?:4[0-9]{12}(?:[0-9]{3})?|[25][1-7][0-9]{14}|6(?:011|5[0-9][0-9])[0-9]{12}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|(?:2131|1800|35\d{3})\d{11})$/u;
const OBJECT_ID = /^[0-9a-f]{24}$/iu;
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/iu;

/**
 * Applies the card number test the Hawk grouper runs on the values of `context` and `addons`.
 * @param value Any value of the event.
 * @returns True when the grouper would replace a string with `[filtered]`.
 */
function looksLikeCardNumber(value: unknown): boolean {
  if (typeof value === 'string') {
    return !OBJECT_ID.test(value) && !UUID.test(value) && PAN_PATTERN.test(value.replaceAll(/\D/gu, ''));
  }

  if (Array.isArray(value)) {
    return value.some(looksLikeCardNumber);
  }

  return typeof value === 'object' && value !== null && Object.values(value).some(looksLikeCardNumber);
}

describe('eventMessage', () => {
  it.each(['http', 'ws'] as const)('carries the fields of the card over %s', (transport) => {
    const { context, plan } = scenario({ transport });
    const { payload, catcherType } = eventMessage(context);
    const instanceId = plan.context.instanceId;

    expect(catcherType).toBe(plan.catcherType);
    expect(payload).toMatchObject({ title: plan.title,
      type: 'E2eMonitorCheck',
      release: `e2e-${instanceId}-plain`,
      user: { id: `e2e-${instanceId}`,
        name: 'e2e monitor' },
      get: { e2e: plan.runId },
      addons: { userAgent: BROWSER_USER_AGENT,
        token: 'e2e-sentinel' },
      context: { ...plan.context,
        password: 'e2e-sentinel' } });

    const frames = payload.backtrace as Array<Record<string, unknown>>;

    expect(frames).toHaveLength(3);

    for (const frame of frames) {
      expect(frame).toMatchObject({ file: expect.any(String) as string,
        line: expect.any(Number) as number,
        column: expect.any(Number) as number,
        function: expect.any(String) as string,
        arguments: expect.any(Array) as unknown[] });
      expect(frame.sourceCode).toHaveLength(3);
      expect((frame.sourceCode as Array<Record<string, unknown>>)[0]).toMatchObject({ line: expect.any(Number) as number,
        content: expect.any(String) as string });
    }

    const crumbs = payload.breadcrumbs as Array<Record<string, unknown>>;

    expect(crumbs).toHaveLength(2);

    for (const crumb of crumbs) {
      expect(crumb).toMatchObject({ timestamp: expect.any(Number) as number,
        type: expect.any(String) as string,
        category: expect.any(String) as string,
        message: expect.any(String) as string,
        level: expect.any(String) as string });
      // Hawk reads breadcrumb times as milliseconds.
      expect(crumb.timestamp).toBeGreaterThan(1e12);
    }
  });

  it('is the same message every time, so a repeat matches the first event', () => {
    const { context } = scenario();

    expect(eventMessage(context)).toEqual(eventMessage(context));
  });

  it.each(['http', 'ws'] as const)('stays within what the grouper keeps over %s', (transport) => {
    const { payload } = eventMessage(scenario({ transport }).context);

    expect(withinEventLimits(payload)).toBeUndefined();
  });

  it('keeps the user agent and every other string of context and addons out of the card number filter', () => {
    const { payload } = eventMessage(scenario().context);

    expect(looksLikeCardNumber(payload.context)).toBe(false);
    expect(looksLikeCardNumber(payload.addons)).toBe(false);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
  });
});

describe('withinEventLimits', () => {
  const ok = { title: 'x',
    context: { a: 'x' },
    addons: {},
    backtrace: [] };

  it('accepts values at the maximum', () => {
    const keys = Object.fromEntries(Array.from({ length: EVENT_LIMITS.keys - 1 }, (_, index) => [`k${String(index)}`, 'y'.repeat(EVENT_LIMITS.string)]));

    expect(withinEventLimits({ ...ok,
      title: 't'.repeat(EVENT_LIMITS.title),
      context: { ...keys,
        list: [] },
      backtrace: [{ sourceCode: Array.from({ length: EVENT_LIMITS.sourceLines }, () => ({ line: 1,
        content: 'z'.repeat(EVENT_LIMITS.sourceLine) })) }] })).toBeUndefined();
  });

  it('names the first value over a limit', () => {
    expect(withinEventLimits({ ...ok,
      title: 't'.repeat(401) })).toContain('title');
    expect(withinEventLimits({ ...ok,
      context: { long: 'y'.repeat(201) } })).toContain('context.long');
    expect(withinEventLimits({ ...ok,
      addons: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${String(index)}`, 1])) })).toContain('addons');
    expect(withinEventLimits({ ...ok,
      context: { list: Array.from({ length: 11 }, () => 1) } })).toContain('context.list');
    expect(withinEventLimits({ ...ok,
      context: { a: { b: { c: { d: { e: { f: 1 } } } } } } })).toContain('depth');
    expect(withinEventLimits({ ...ok,
      backtrace: [{ sourceCode: Array.from({ length: 22 }, () => ({ line: 1,
        content: 'z' })) }] })).toContain('sourceCode');
    expect(withinEventLimits({ ...ok,
      backtrace: [{ sourceCode: [{ line: 1,
        content: 'z'.repeat(141) }] }] })).toContain('sourceCode');
  });
});

/** Paths of the fields the card is compared on, one per value the event sends. */
const CARD_PATHS = [
  'type', 'release', 'user.id', 'user.name', 'get.e2e', 'addons.userAgent', 'addons.token', 'context.password', 'context.sequence',
  ...[0, 1].flatMap(index => ['timestamp', 'type', 'category', 'message', 'level'].map(key => `breadcrumbs[${String(index)}].${key}`)),
  ...[0, 1, 2].flatMap(index => ['file', 'line', 'column', 'function', 'arguments', 'sourceCode'].map(key => `backtrace[${String(index)}].${key}`)),
];

/**
 * Removes the value at a path such as `backtrace[1].line`.
 * @param payload Payload to change.
 * @param path Dotted path with indexes in brackets.
 * @returns The same payload without the value.
 */
function deleteAt(payload: Record<string, unknown>, path: string): Record<string, unknown> {
  const steps = path.split(/[.[\]]+/u).filter(step => step !== '');
  const last = steps.pop() ?? '';
  let target: unknown = payload;

  for (const step of steps) {
    target = (target as Record<string, unknown>)[step];
  }

  Reflect.deleteProperty(target as Record<string, unknown>, last);

  return payload;
}

describe('the fields of the card', () => {
  it.each(CARD_PATHS)('a lost %s fails the event as event_mismatch naming the field', async (path) => {
    const { context } = scenario();

    hawk.collector.knobs.mutatePayload = payload => deleteAt(payload, path);

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_mismatch',
      culprit: 'hawk' });
    expect(result.message).toContain(path);
  });

  it('passes when every field arrives', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect((await run(eventVisibleStage(TIMEOUT_MS), context)).status).toBe('ok');
  });

  it('fails with field_not_masked when the password and the token arrive as sent', async () => {
    const { context } = scenario();

    hawk.store.knobs.unmasked = true;
    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'field_not_masked',
      culprit: 'hawk' });
    expect(result.message).toContain('context.password');
  });

  it('fails an errors/nodejs event that carries beautifiedUserAgent', async () => {
    const { context } = scenario({ transport: 'http' });

    hawk.collector.knobs.mutatePayload = (payload) => {
      (payload.addons as Record<string, unknown>).beautifiedUserAgent = { os: 'Linux' };

      return payload;
    };
    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_mismatch' });
    expect(result.message).toContain('unexpected field beautifiedUserAgent');
  });

  it('accepts the beautifiedUserAgent that the JavaScript worker adds, and its absence', async () => {
    const withWorker = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), withWorker.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), withWorker.context)).status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)[0]?.payload.addons).toHaveProperty('beautifiedUserAgent');

    // The second run has the same run id, so the first event must go.
    hawk.store.remove(hawk.projectId, hawk.store.all(hawk.projectId)[0]?.id ?? '');

    hawk.store.knobs.noJsWorker = true;

    const without = scenario({ transport: 'ws',
      sequence: 2 });

    await run(collectorAcceptStage(TIMEOUT_MS), without.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), without.context)).status).toBe('ok');
  });

  it('marks a JavaScript event without the JavaScript worker as degraded, not failed', async () => {
    hawk.store.knobs.noJsWorker = true;

    const { context } = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toEqual(['js_worker_not_seen']);
    expect(result.details?.warning).toContain('beautifiedUserAgent');
  });

  it('has no degradation when the JavaScript worker answered or the event is not JavaScript', async () => {
    const withWorker = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), withWorker.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), withWorker.context)).details?.degraded).toBeUndefined();

    hawk.store.remove(hawk.projectId, hawk.store.all(hawk.projectId)[0]?.id ?? '');

    const node = scenario({ transport: 'http' });

    await run(collectorAcceptStage(TIMEOUT_MS), node.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), node.context)).details?.degraded).toBeUndefined();
  });

  describe('the shape of beautifiedUserAgent on a JavaScript event', () => {
    /**
     * Builds the card of a JavaScript event with a given value of the field.
     * @param value Value of `addons.beautifiedUserAgent`; the key is left out when undefined.
     * @returns The error of the check and nothing else.
     */
    function checked(value: unknown): CheckError | undefined {
      const { context, plan } = scenario({ transport: 'ws' });
      const sent = eventMessage(context).payload;
      const groomed = groom(plan.catcherType, sent);
      const addons = { ...groomed.addons as Record<string, unknown> };

      if (value === undefined) {
        delete addons.beautifiedUserAgent;
      } else {
        addons.beautifiedUserAgent = value;
      }

      return checkCard({ originalEventId: 'e',
        groupHash: 'g',
        totalCount: 1,
        catcherType: plan.catcherType,
        title: plan.title,
        ...groomed,
        addons,
        usersAffected: 1 } as EventCard, sent, plan, 1);
    }

    it('accepts an object with the four string fields, extra fields included, and an absent value', () => {
      expect(checked({ os: 'Linux',
        osVersion: '6',
        browser: 'Chrome',
        browserVersion: '120',
        extra: 1 })).toBeUndefined();
      expect(checked(undefined)).toBeUndefined();
    });

    it.each([
      ['null', null],
      ['an empty object', {}],
      ['an object without osVersion', { os: 'Linux',
        browser: 'Chrome',
        browserVersion: '120' }],
      ['a field that is not a string', { os: 'Linux',
        osVersion: 6,
        browser: 'Chrome',
        browserVersion: '120' }],
      ['an array', []],
      ['a string', 'Linux'],
    ])('rejects %s as event_mismatch of addons.beautifiedUserAgent', (_label, value) => {
      expect(checked(value)).toMatchObject({ errorClass: 'event_mismatch',
        facts: { field: 'addons.beautifiedUserAgent' } });
    });
  });

  it('checks that one user was affected', () => {
    const { context, plan } = scenario();
    const sent = eventMessage(context).payload;
    const card = (usersAffected: number | undefined): EventCard => ({ originalEventId: 'e',
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      title: plan.title,
      ...groom(plan.catcherType, sent),
      ...usersAffected === undefined ? {} : { usersAffected } } as EventCard);

    expect(checkCard(card(1), sent, plan, 1)).toBeUndefined();
    expect(checkCard(card(2), sent, plan, 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'usersAffected',
        expected: '1',
        actual: '2' } });
    expect(checkCard(card(undefined), sent, plan, 1)).toMatchObject({ errorClass: 'event_mismatch' });
  });
});

describe('eventVisibleStage on a fake clock', () => {
  const STAGE_MS = 10_000;
  const HTTP_MS = 2000;

  /** What a run on the fake clock leaves. */
  interface FakeRun {
    /** Recorded stage result. */
    result: StageResult;
    /** Context the stage ran in. */
    context: ScenarioContext;
  }

  /**
   * Runs the stage with an API whose answers take fake time.
   * @param appearsAtMs When the search starts to find the event.
   * @param cardMs How long the card read takes.
   * @returns The result and the context.
   */
  async function runOnFakeClock(appearsAtMs: number, cardMs: number): Promise<FakeRun> {
    const clock = createFakeClock();
    const { context, plan } = createTestScenario(hawk);
    const found = { originalEventId: 'e'.repeat(24),
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      ...groom(plan.catcherType, eventMessage(context).payload),
      usersAffected: 1 } as EventCard;
    const api: HawkApi = { ...context.api,
      findEvents: () => Promise.resolve(clock.monotonicMs() >= appearsAtMs ? [found] : []),
      eventCard: async (_projectId, _eventId, signal) => {
        await clock.sleep(cardMs, signal);

        return found;
      } };
    const fake: ScenarioContext = { ...context,
      api,
      clock,
      pollScheduleMs: [500],
      config: { ...context.config,
        httpTimeoutMs: HTTP_MS } };
    const running = runStage(eventVisibleStage(STAGE_MS), fake, { clock,
      runSignal: new AbortController().signal });

    // Small steps, so a sleep that a loaded machine registers late is still reached.
    for (let elapsed = 0; elapsed < STAGE_MS + 2000; elapsed += 100) {
      await clock.advance(100);
    }

    return { result: await running,
      context: fake };
  }

  it('an event found at the end of the search gets its card read before the deadline', async () => {
    const { result } = await runOnFakeClock(7500, HTTP_MS - 1);

    expect(result.status).toBe('ok');
  });

  it('the search stops HTTP_TIMEOUT_MS before the deadline', async () => {
    const { result } = await runOnFakeClock(Number.POSITIVE_INFINITY, 0);
    const waitedMs = Number(result.details?.waitedMs);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_not_found' });
    expect(waitedMs).toBeGreaterThanOrEqual(7000);
    expect(waitedMs).toBeLessThan(9000);
  });

  it('an event that appears inside the last HTTP timeout is not found, and no card is read', async () => {
    const { result, context } = await runOnFakeClock(STAGE_MS - 1000, 0);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_not_found' });
    expect(context.state.event).toBeUndefined();
  });
});
