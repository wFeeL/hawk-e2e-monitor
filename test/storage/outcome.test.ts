import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/load.js';
import { testConfig } from '../support/config.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import type { RunResult } from '../../src/engine/result.js';
import { abortedOutcome, eventsPerRun, isMonitorAbort, isVerdict, outcomeOf, eventsSentPer30Days, rowOf } from '../../src/storage/outcome.js';

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

  it('takes the codes a stage reports in details.degraded, each once', () => {
    const result = runResultFixture({ stages: [
      stageFixture('api_availability', 'ok', 0, { details: { degraded: ['grouping_pattern'] } }),
      stageFixture('event_visible', 'ok', 0, { details: { degraded: ['js_worker_not_seen', 'grouping_pattern'] } }),
    ] });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual(['js_worker_not_seen', 'grouping_pattern']);
  });

  it('ignores a code that is not a degradation code and reports nothing for a failed run', () => {
    const odd = runResultFixture({ stages: [stageFixture('event_visible', 'ok', 0, { details: { degraded: ['nope', 7] } })] });

    expect(outcomeOf(odd, CONTEXT).degraded).toEqual([]);
    expect(outcomeOf({ ...odd,
      status: 'failed' }, CONTEXT).degraded).toEqual([]);
  });

  it('accept_uncertain: the collector did not confirm the event', () => {
    const result = runResultFixture({ stages: [stageFixture('collector_accept', 'uncertain'), stageFixture('event_visible')] });

    expect(outcomeOf(result, CONTEXT)).toMatchObject({ status: 'ok',
      degraded: ['accept_uncertain'] });
  });

  it('accept_uncertain: the collector did not confirm the repeated event', () => {
    const result = runResultFixture({ stages: [stageFixture('collector_accept'),
      stageFixture('event_repeated', 'ok', 10, { details: { repeatUncertain: true } })] });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual(['accept_uncertain']);
  });

  it('accept_uncertain is given once when both sends were unconfirmed, and a confirmed repeat adds nothing', () => {
    const both = runResultFixture({ stages: [stageFixture('collector_accept', 'uncertain'),
      stageFixture('event_repeated', 'ok', 10, { details: { repeatUncertain: true } })] });
    const confirmed = runResultFixture({ stages: [stageFixture('collector_accept'),
      stageFixture('event_repeated', 'ok', 10, { details: { repeatUncertain: false } })] });

    expect(outcomeOf(both, CONTEXT).degraded).toEqual(['accept_uncertain']);
    expect(outcomeOf(confirmed, CONTEXT).degraded).toEqual([]);
  });

  it('lists the codes as single_channel, quota_usage, accept_uncertain', () => {
    const result = notificationResult({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quotaLow: true } }),
      stageFixture('collector_accept', 'uncertain'),
      stageFixture('notification_formed', 'ok', 50)],
    notification: { loop: { latencyMs: 20 },
      unmatched: 0 } });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual(['single_channel', 'quota_usage', 'accept_uncertain']);
  });

  it('both channels arrived is not degraded', () => {
    expect(outcomeOf(notificationResult(), CONTEXT).degraded).toEqual([]);
  });

  it('single_channel is only for check-notification and only for ok', () => {
    expect(outcomeOf(runResultFixture({ notification: { unmatched: 0 } }), CONTEXT).degraded).toEqual([]);
    expect(outcomeOf(notificationResult({ status: 'failed',
      notification: { unmatched: 0 } }), CONTEXT).degraded).toEqual([]);
  });

  it('quota_usage when the quota stage found the event limit nearly used', () => {
    const low = runResultFixture({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quotaLow: true,
      quota: { eventsCount: 950,
        eventsLimit: 1000 } } })] });
    const fine = runResultFixture({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsCount: 5,
      eventsLimit: 1000 } } })] });

    expect(outcomeOf(low, CONTEXT).degraded).toEqual(['quota_usage']);
    expect(outcomeOf(fine, CONTEXT).degraded).toEqual([]);
  });

  it('the events the monitor sends never degrade a run by themselves', () => {
    const result = runResultFixture({ stages: [stageFixture('api_availability', 'ok', 10, { details: { quota: { eventsCount: 0,
      eventsLimit: 10 } } })] });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual([]);
  });

  it('quota_usage is only for ok runs', () => {
    const failed = runResultFixture({ status: 'failed',
      stages: [stageFixture('api_availability', 'ok', 10, { details: { quotaLow: true } })] });

    expect(outcomeOf(failed, CONTEXT).degraded).toEqual([]);
  });

  it('lists both codes in a fixed order', () => {
    const result = notificationResult({ notification: { unmatched: 0 },
      stages: [stageFixture('api_availability', 'ok', 10, { details: { quotaLow: true } }),
        stageFixture('notification_formed')] });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual(['single_channel', 'quota_usage']);
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
      message: 'The run did not finish within 9m 0s and was abandoned',
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

    expect(eventsSentPer30Days(only)).toBeCloseTo(DAY_RUNS * 30 * (1 + 1 / 12));
  });

  it('applies the repeat share to the two scenarios that repeat and not to the others', () => {
    const config = testConfig();
    const monitoring = (scenarios: Config['monitoring']['scenarios']): Config['monitoring'] => ({ ...config.monitoring,
      scenarios });

    // Every other scenario runs once an hour by default: 24 runs a day, 720 in 30 days.
    expect(eventsSentPer30Days(testConfig({ monitoring: monitoring(['sourcemaps']) }))).toBeCloseTo(720);
    expect(eventsSentPer30Days(testConfig({ monitoring: monitoring(['sentry-envelope']) }))).toBeCloseTo(720);
    expect(eventsSentPer30Days(testConfig({ monitoring: monitoring(['new-project']) }))).toBeCloseTo(30);
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

    expect(eventsSentPer30Days(one)).toBe(DAY_RUNS * 30);
    expect(eventsSentPer30Days(two)).toBe(DAY_RUNS * 30 * 2);
  });
});

describe('isVerdict', () => {
  it('counts ok, failed and the warmup skip, not an overlap skip or a running run', () => {
    expect(isVerdict({ status: 'ok' })).toBe(true);
    expect(isVerdict({ status: 'failed' })).toBe(true);
    expect(isVerdict({ status: 'skipped',
      skipReason: 'rule_cache_warmup' })).toBe(true);
    expect(isVerdict({ status: 'skipped',
      skipReason: 'overlap' })).toBe(false);
    expect(isVerdict({ status: 'running' })).toBe(false);
  });

  it('leaves the warmup skip out on request', () => {
    expect(isVerdict({ status: 'skipped',
      skipReason: 'rule_cache_warmup' }, { warmup: false })).toBe(false);
    expect(isVerdict({ status: 'ok' }, { warmup: false })).toBe(true);
  });

  it('counts an abort only on request and never one by a stop or restart of the monitor', () => {
    expect(isVerdict({ status: 'aborted',
      errorClass: 'run_hung' })).toBe(false);
    expect(isVerdict({ status: 'aborted',
      errorClass: 'run_hung' }, { aborts: true })).toBe(true);
    expect(isVerdict({ status: 'aborted',
      errorClass: 'monitor_stopped' }, { aborts: true })).toBe(false);
    expect(isVerdict({ status: 'aborted',
      errorClass: 'monitor_restarted' }, { aborts: true })).toBe(false);
  });
});

describe('isMonitorAbort', () => {
  it('is true for a stop and a restart only', () => {
    expect(isMonitorAbort({ status: 'aborted',
      errorClass: 'monitor_stopped' })).toBe(true);
    expect(isMonitorAbort({ status: 'aborted',
      errorClass: 'monitor_restarted' })).toBe(true);
    expect(isMonitorAbort({ status: 'aborted',
      errorClass: 'run_hung' })).toBe(false);
    expect(isMonitorAbort({ status: 'failed',
      errorClass: 'monitor_stopped' })).toBe(false);
  });
});

describe('the probe', () => {
  it('does not change the projection of the events sent in 30 days', () => {
    const config = testConfig();
    const base = { ...config.monitoring,
      intervalMs: 600_000 };
    const without = testConfig({ monitoring: { ...base,
      scenarios: ['send-and-receive-event'] } });
    const withProbe = testConfig({ monitoring: { ...base,
      scenarios: ['send-and-receive-event', 'endpoints-probe'] } });

    expect(eventsSentPer30Days(withProbe)).toBe(eventsSentPer30Days(without));
  });

  it('is never degraded by the quota, because its API stage only reads it', () => {
    const result = runResultFixture({ scenario: 'endpoints-probe',
      stages: [stageFixture('api_availability', 'ok', 10, { details: { quotaLow: true } })] });

    expect(outcomeOf(result, CONTEXT).degraded).toEqual([]);
  });

  it('is stored from a result that has no transport, catcher type or title', () => {
    const { transport: _transport, catcherType: _catcher, title: _title, ...fields } = runResultFixture({ scenario: 'endpoints-probe' });
    const outcome = outcomeOf(fields, CONTEXT);

    expect(outcome.status).toBe('ok');
    expect(rowOf({ runId: 'raaaaaaaaaaaaaaaa',
      scenario: 'endpoints-probe',
      sequence: 1,
      trigger: 'schedule',
      startedAt: '2026-03-10T10:00:00.000Z' }, outcome).status).toBe('ok');
  });
});
