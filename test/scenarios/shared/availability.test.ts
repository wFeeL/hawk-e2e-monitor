import { describe, expect, it } from 'vitest';
import { encodeToken } from '../../support/fake-hawk/index.js';
import { apiAvailabilityStage, collectorAvailabilityStage } from '../../../src/scenarios/shared/availability.js';
import { TIMEOUT_MS, run, scenario, useStageHarness } from '../../support/stage-harness.js';

const harness = useStageHarness();

describe('collectorAvailabilityStage', () => {
  it('is ok on a healthy collector', async () => {
    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.status).toBe('ok');
  });

  it('fails with collector_dependency_error when a health flag is false', async () => {
    harness.hawk().collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'collector_dependency_error',
      culprit: 'hawk' });
  });

  it('fails with collector_unexpected_response when the probe is accepted', async () => {
    harness.hawk().collector.knobs.reply = () => ({ status: 200,
      body: JSON.stringify({ code: 200,
        error: false,
        message: 'OK' }) });

    const result = await run(collectorAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.errorClass).toBe('collector_unexpected_response');
  });
});

describe('apiAvailabilityStage grouping patterns', () => {
  it('says nothing when no pattern catches the title', async () => {
    harness.hawk().api.knobs.groupingPatterns = ['^unrelated'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.warnings).toBeUndefined();
    expect(result.details?.degraded).toBeUndefined();
  });

  it('warns and marks the run when a pattern catches the title', async () => {
    const { context, plan } = scenario();

    harness.hawk().api.knobs.groupingPatterns = ['^unrelated', '\\[e2e:.*\\] .* send-and-receive-event'];

    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toEqual(['grouping_pattern']);
    expect((result.details?.warnings as string[]).join(' ')).toContain('\\[e2e:.*\\] .* send-and-receive-event');
  });

  it('reads a pattern as Hawk does, without the u flag, so an escaped colon still works', async () => {
    harness.hawk().api.knobs.groupingPatterns = ['\\[e2e\\:.*'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.details?.degraded).toEqual(['grouping_pattern']);
    expect(JSON.stringify(result.details?.warnings)).not.toContain('not a regular expression');
  });

  it('only warns about a pattern that is not a regular expression', async () => {
    harness.hawk().api.knobs.groupingPatterns = ['(unclosed'];

    const { context, plan } = scenario();
    const result = await run(apiAvailabilityStage(TIMEOUT_MS, { title: plan.title }), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toBeUndefined();
    expect(JSON.stringify(result.details?.warnings)).toContain('(unclosed');
  });

  it('does not look at the patterns without a title', async () => {
    harness.hawk().api.knobs.groupingPatterns = ['.*'];

    expect((await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context)).details?.degraded).toBeUndefined();
  });

  it('keeps the quota warning next to the pattern warning', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };
    harness.hawk().api.knobs.groupingPatterns = ['.*'];

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
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 1000,
      billingPeriodEventsCount: 12 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details?.quota).toEqual({ eventsCount: 12,
      eventsLimit: 1000 });
  });

  it('keeps the quota next to the warning', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details).toEqual({ warning: 'Event quota is almost used: 95/100',
      quotaLow: true,
      quota: { eventsCount: 95,
        eventsLimit: 100 } });
  });

  it('token_mismatch when the project has another token', async () => {
    harness.hawk().api.knobs.projectToken = encodeToken('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'token_mismatch',
      culprit: 'config' });
  });

  it('token_mismatch when the API token does not decode', async () => {
    harness.hawk().api.knobs.projectToken = 'not a token';

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.errorClass).toBe('token_mismatch');
  });

  it('workspace_blocked when Hawk blocked the workspace', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: true,
      eventsLimit: 100,
      billingPeriodEventsCount: 0 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'workspace_blocked',
      culprit: 'monitor' });
  });

  it('quota_exhausted when the counter reaches the limit', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 100 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(result.message).toContain('100/100');
  });

  it('warns when less than 10 percent of the quota is left', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBe('Event quota is almost used: 95/100');
  });

  it('no warning when exactly 10 percent is left', async () => {
    harness.hawk().api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 90 };

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result.details?.warning).toBeUndefined();
  });

  it('api_unavailable when the API is down', async () => {
    harness.hawk().api.knobs.down = true;

    const result = await run(apiAvailabilityStage(TIMEOUT_MS), scenario().context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'api_unavailable' });
  });
});
