import { describe, expect, it } from 'vitest';
import { testConfig } from '../support/config.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import type { RunResult } from '../../src/engine/result.js';
import { abortedOutcome, eventsPerRun, outcomeOf, projectedEventsPer30Days, rowOf } from '../../src/storage/outcome.js';

const CONTEXT = { loopEnabled: true };

/**
 * Builds a finished `check-notification` result.
 * @param overrides Fields that replace the defaults.
 * @returns Result with both channels arrived.
 */
function notificationResult(overrides: Partial<RunResult> = {}): RunResult {
  return runResultFixture({ scenario: 'check-notification',
    stages: [stageFixture('api_availability'),
      stageFixture('notification_formed', 'ok', 50, { details: { latencyMs: { webhook: 10,
        loop: 20 } } })],
    notification: { webhook: { latencyMs: 10 },
      loop: { latencyMs: 20 },
      unmatched: 0 },
    ...overrides });
}

describe('outcomeOf', () => {
  it('maps a failed result with its error fields', () => {
    const outcome = outcomeOf(runResultFixture({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk',
      message: 'Event did not appear' }), CONTEXT);

    expect(outcome).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk',
      message: 'Event did not appear',
      finishedAt: '2026-03-10T10:00:05.000Z',
      durationMs: 5000,
      degraded: [] });
    expect(outcome.skipReason).toBeUndefined();
  });

  it('maps a clean ok result', () => {
    const result = runResultFixture();

    expect(outcomeOf(result, CONTEXT)).toEqual({ status: 'ok',
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      degraded: [],
      result });
  });

  it('turns a warmup skip of notification_formed into skipped rule_cache_warmup', () => {
    const outcome = outcomeOf(notificationResult({ stages: [stageFixture('notification_formed', 'skipped', 0, { details: { reason: 'rule_cache_warmup' } })],
      notification: undefined }), CONTEXT);

    expect(outcome).toMatchObject({ status: 'skipped',
      skipReason: 'rule_cache_warmup',
      degraded: [] });
  });

  it('keeps ok for another skip reason', () => {
    expect(outcomeOf(notificationResult({ stages: [stageFixture('notification_formed', 'skipped', 0, { details: { reason: 'other' } })] }), CONTEXT).status).toBe('ok');
  });

  it('single_channel: the webhook did not arrive', () => {
    const outcome = outcomeOf(notificationResult({ notification: { loop: { latencyMs: 20 },
      unmatched: 0 } }), CONTEXT);

    expect(outcome.degraded).toEqual(['single_channel']);
  });

  it('single_channel: the loop is enabled and did not arrive', () => {
    const result = notificationResult({ notification: { webhook: { latencyMs: 10 },
      unmatched: 0 } });

    expect(outcomeOf(result, { loopEnabled: true }).degraded).toEqual(['single_channel']);
    expect(outcomeOf(result, { loopEnabled: false }).degraded).toEqual([]);
  });

  it('both channels arrived is not degraded', () => {
    expect(outcomeOf(notificationResult(), CONTEXT).degraded).toEqual([]);
  });

  it('single_channel is only for check-notification and only for ok', () => {
    expect(outcomeOf(runResultFixture({ notification: { unmatched: 0 } }), CONTEXT).degraded).toEqual([]);
    expect(outcomeOf(notificationResult({ status: 'failed',
      notification: { unmatched: 0 } }), CONTEXT).degraded).toEqual([]);
  });

  it('quota_projection when the projected events exceed eventsLimit', () => {
    const result = runResultFixture({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsCount: 5,
      eventsLimit: 1000 } } })] });

    expect(outcomeOf(result, { ...CONTEXT,
      projectedEventsPer30Days: 1001 }).degraded).toEqual(['quota_projection']);
    expect(outcomeOf(result, { ...CONTEXT,
      projectedEventsPer30Days: 1000 }).degraded).toEqual([]);
    expect(outcomeOf(result, CONTEXT).degraded).toEqual([]);
  });

  it('quota_projection ignores a limit that is not a number and failed runs', () => {
    const odd = runResultFixture({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsLimit: '1000' } } })] });
    const failed = runResultFixture({ status: 'failed',
      stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsLimit: 10 } } })] });

    expect(outcomeOf(odd, { ...CONTEXT,
      projectedEventsPer30Days: 99_999 }).degraded).toEqual([]);
    expect(outcomeOf(failed, { ...CONTEXT,
      projectedEventsPer30Days: 99_999 }).degraded).toEqual([]);
  });

  it('lists both codes in a fixed order', () => {
    const result = notificationResult({ notification: { unmatched: 0 },
      stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsLimit: 10 } } }),
        stageFixture('notification_formed')] });

    expect(outcomeOf(result, { ...CONTEXT,
      projectedEventsPer30Days: 100 }).degraded).toEqual(['single_channel', 'quota_projection']);
  });
});

describe('abortedOutcome and rowOf', () => {
  it('builds an aborted outcome with the class text and culprit', () => {
    expect(abortedOutcome('run_hung', { waitedMs: 540_000 }, '2026-03-10T10:09:00.000Z', 540_000)).toEqual({
      status: 'aborted',
      finishedAt: '2026-03-10T10:09:00.000Z',
      durationMs: 540_000,
      degraded: [],
      errorClass: 'run_hung',
      culprit: 'monitor',
      message: 'The run did not finish within 540000 ms and was abandoned',
    });
    expect(abortedOutcome('monitor_internal', { detail: 'scenario threw: boom' }, 'x', 1).message).toContain('scenario threw: boom');
  });

  it('builds the row of a run that never reached the database', () => {
    const result = runResultFixture({ eventLatencyMs: 77,
      stages: [stageFixture('cleanup', 'ok', 5, { errorClass: undefined })] });
    const row = rowOf({ runId: result.runId,
      scenario: 'send-and-receive-event',
      sequence: 3,
      trigger: 'schedule',
      startedAt: result.startedAt }, outcomeOf(result, CONTEXT));

    expect(row).toMatchObject({ id: 0,
      runId: result.runId,
      sequence: 3,
      status: 'ok',
      eventLatencyMs: 77,
      degraded: [],
      stages: [{ name: 'cleanup',
        status: 'ok',
        durationMs: 5 }] });
  });
});

describe('projection', () => {
  const DAY_RUNS = 144;

  it('eventsPerRun follows the transport mode and the repeat period, for both scenarios alike', () => {
    expect(eventsPerRun(testConfig())).toBeCloseTo(1 + 1 / 12);
    expect(eventsPerRun(testConfig({ transportMode: 'http',
      repeatEveryNRuns: 6 }))).toBeCloseTo(1 + 1 / 6);
    expect(eventsPerRun(testConfig({ repeatEveryNRuns: 0 }))).toBe(1);
  });

  it('projects repeat events of check-notification too', () => {
    const config = testConfig();
    const only = testConfig({ monitoring: { ...config.monitoring,
      intervalMs: 600_000,
      scenarios: ['check-notification'] } });

    expect(projectedEventsPer30Days(only)).toBeCloseTo(DAY_RUNS * 30 * (1 + 1 / 12));
  });

  it('projects 144 runs a day per scenario at a 600000 ms interval', () => {
    const config = testConfig();
    const base = { ...config.monitoring,
      intervalMs: 600_000 };
    const one = testConfig({ repeatEveryNRuns: 0,
      monitoring: { ...base,
        scenarios: ['send-and-receive-event'] } });
    const two = testConfig({ repeatEveryNRuns: 0,
      monitoring: { ...base,
        scenarios: ['send-and-receive-event', 'check-notification'] } });

    expect(projectedEventsPer30Days(one)).toBe(DAY_RUNS * 30);
    expect(projectedEventsPer30Days(two)).toBe(DAY_RUNS * 30 * 2);
  });
});
