import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FoundEvent } from '../../clients/hawk-api.js';
import { runStage } from '../../engine/stages.js';
import type { StageResult } from '../../engine/result.js';
import type { StageSpec } from '../../engine/stages.js';
import { systemClock } from '../../time/clock.js';
import { encodeToken, startFakeHawk } from '../../test-support/fake-hawk/index.js';
import type { FakeHawk } from '../../test-support/fake-hawk/index.js';
import { testConfig } from '../../test-support/config.js';
import { TIMEOUT_LIMITS, createTestScenario } from '../../test-support/scenario.js';
import type { TestScenarioOptions } from '../../test-support/scenario.js';
import { planRun } from './plan.js';
import { apiAvailabilityStage, checkEventFields, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventVisibleStage, isOurEvent } from './stages.js';
import type { ScenarioContext } from './stages.js';

const BUDGET_MS = 2000;
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
    const result = await run(collectorAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result.status).toBe('ok');
  });

  it('fails with collector_dependency_error when a health flag is false', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run(collectorAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'collector_dependency_error',
      culprit: 'hawk' });
  });

  it('fails with collector_unexpected_response when the probe is accepted', async () => {
    hawk.collector.knobs.reply = () => ({ status: 200,
      body: JSON.stringify({ code: 200,
        error: false,
        message: 'OK' }) });

    const result = await run(collectorAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result.errorClass).toBe('collector_unexpected_response');
  });
});

describe('apiAvailabilityStage', () => {
  it('is ok on a healthy API', async () => {
    const { context } = scenario();
    const result = await run(apiAvailabilityStage(BUDGET_MS), context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBeUndefined();
  });

  it('token_mismatch when the project has another token', async () => {
    hawk.api.knobs.projectToken = encodeToken('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'token_mismatch',
      culprit: 'config' });
  });

  it('token_mismatch when the API token does not decode', async () => {
    hawk.api.knobs.projectToken = 'not a token';

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result.errorClass).toBe('token_mismatch');
  });

  it('workspace_blocked when Hawk blocked the workspace', async () => {
    hawk.api.knobs.workspace = { isBlocked: true,
      eventsLimit: 100,
      billingPeriodEventsCount: 0 };

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'workspace_blocked',
      culprit: 'monitor' });
  });

  it('quota_exhausted when the counter reaches the limit', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 100 };

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(result.message).toContain('100/100');
  });

  it('warns when less than 10 percent of the quota is left', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBe('Event quota is almost used: 95/100');
  });

  it('no warning when exactly 10 percent is left', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 90 };

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result.details?.warning).toBeUndefined();
  });

  it('api_unavailable when the API is down', async () => {
    hawk.api.knobs.down = true;

    const result = await run(apiAvailabilityStage(BUDGET_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'api_unavailable' });
  });
});

describe('collectorAcceptStage', () => {
  it.each(['http', 'ws'] as const)('is ok over %s and the event reaches the store', async (transport) => {
    const { context, plan } = scenario({ transport });
    const result = await run(collectorAcceptStage(BUDGET_MS), context);

    expect(result.status).toBe('ok');
    expect(context.state.sendOutcome?.kind).toBe('accepted');
    expect(context.state.acceptedAtMs).toBeTypeOf('number');
    expect(context.state.sendMayHaveReached).toBe(false);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(1);

    const [stored] = hawk.store.all(hawk.projectId);

    expect(stored?.catcherType).toBe(plan.catcherType);
    expect(stored?.payload).toEqual({ title: plan.title,
      type: 'e2e-check',
      context: plan.context,
      backtrace: [{ file: 'hawk-e2e-monitor/check.js',
        line: 1,
        column: 1,
        function: 'check' }] });
  });

  it('payload carries one backtrace frame', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(BUDGET_MS), context);

    const [stored] = hawk.store.all(hawk.projectId);

    expect(stored?.payload.backtrace).toEqual([{ file: 'hawk-e2e-monitor/check.js',
      line: 1,
      column: 1,
      function: 'check' }]);
  });

  it('fails with the class of a rejection and does not mark the send as reached', async () => {
    hawk.collector.knobs.reply = () => ({ status: 402,
      body: QUOTA_REFUSAL });

    const { context } = scenario();
    const result = await run(collectorAcceptStage(BUDGET_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(context.state.sendMayHaveReached).toBe(false);
  });

  it('is uncertain when the answer times out, and sends exactly once', async () => {
    hawk.collector.knobs.replyDelayMs = 300;

    const { context } = scenario({ env: TIMEOUT_LIMITS });
    const before = context.clock.monotonicMs();
    const result = await run(collectorAcceptStage(BUDGET_MS), context);

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
  it('skips the recheck when the pause is cut by the budget, and still tries to remove', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(BUDGET_MS), context);
    await run(eventVisibleStage(BUDGET_MS), context);

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
