import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/errors/redact.js';
import type { RunResult } from '../../src/engine/result.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import type { AlertStateRow } from '../../src/storage/types.js';
import type { RunRow } from '../../src/storage/types.js';
import { ALERT_TEXT_LIMIT, alertText, escapeHtml, plainAlertText, storageFailingText } from '../../src/alerting/text.js';
import type { AlertTextInput } from '../../src/alerting/text.js';

const NOW = '2026-03-10T13:05:03.000Z';
const IDENTITY = (text: string): string => text;

/**
 * Builds a run row that failed in `event_visible`.
 * @param overrides Fields that replace the defaults.
 * @returns Run row.
 */
function failedRow(overrides: Partial<RunRow> = {}): RunRow {
  return { id: 1,
    runId: 'raaaaaaaaaaaaaaaa',
    scenario: 'send-and-receive-event',
    sequence: 12,
    trigger: 'schedule',
    status: 'failed',
    startedAt: '2026-03-10T12:00:00.000Z',
    finishedAt: '2026-03-10T12:02:00.000Z',
    durationMs: 120_000,
    failedStage: 'event_visible',
    errorClass: 'event_not_found',
    culprit: 'hawk',
    message: 'Event did not appear within 2m 0s: API answered 20 times, failed 3 times',
    eventLatencyMs: 2100,
    degraded: [],
    stages: [{ name: 'collector_availability',
      status: 'ok',
      durationMs: 120 },
    { name: 'api_availability',
      status: 'ok',
      durationMs: 340 },
    { name: 'collector_accept',
      status: 'ok',
      durationMs: 80 },
    { name: 'event_visible',
      status: 'failed',
      durationMs: 120_000 },
    { name: 'cleanup',
      status: 'ok',
      durationMs: 900 }],
    ...overrides };
}

/**
 * Builds the state after a transition.
 * @param overrides Fields that replace a failing state.
 * @returns Alert state.
 */
function stateRow(overrides: Partial<AlertStateRow> = {}): AlertStateRow {
  return { scenario: 'send-and-receive-event',
    state: 'failing',
    failureStreak: 3,
    lastClass: 'event_not_found',
    lastStage: 'event_visible',
    lastRunId: 'raaaaaaaaaaaaaaaa',
    episodeStartedAt: '2026-03-10T12:00:00.000Z',
    episodeFailures: 3,
    degraded: [],
    open: [],
    announced: true,
    reported: [],
    updatedAt: NOW,
    ...overrides };
}

/**
 * Builds the input of `alertText`.
 * @param overrides Fields that replace a FAILED input.
 * @returns Text input.
 */
function input(overrides: Partial<AlertTextInput> = {}): AlertTextInput {
  return { kind: 'failed',
    instanceId: 'prod',
    scenario: 'send-and-receive-event',
    row: failedRow(),
    state: stateRow(),
    now: NOW,
    ...overrides };
}

/**
 * Builds a result with notification latencies.
 * @param overrides Fields that replace the defaults.
 * @returns Result of a check-notification run.
 */
function notificationResult(overrides: Partial<RunResult> = {}): RunResult {
  return runResultFixture({ scenario: 'check-notification',
    notification: { webhook: { latencyMs: 3400 },
      loop: { latencyMs: 3600 },
      unmatched: 0 },
    stages: [stageFixture('cleanup')],
    ...overrides });
}

/**
 * Takes the lines of a text.
 * @param text Text with line breaks.
 * @returns One string per line.
 */
function lines(text: string): string[] {
  return text.split('\n');
}

describe('escapeHtml', () => {
  it('escapes & < > and nothing else', () => {
    expect(escapeHtml('a & b <c> "d" \'e\'')).toBe('a &amp; b &lt;c&gt; "d" \'e\'');
  });
});

describe('alertText: empty message', () => {
  it('leaves no empty line group when the failure has no message', () => {
    const text = alertText(input({ row: failedRow({ message: undefined }) }), IDENTITY);

    expect(text).not.toContain('\n\n\n');
    expect(text).toContain('class event_not_found | culprit hawk\n\nrun #12');
  });

  it('STILL FAILING without an earlier cause names only how long it has lasted', () => {
    const text = alertText(input({ kind: 'still_failing',
      state: stateRow({ reported: ['event_visible/event_not_found'],
        episodeStartedAt: new Date(Date.parse(NOW) - 60_000).toISOString() }) }), IDENTITY);

    expect(text).toContain('failing for 1m 0s');
    expect(text).not.toContain('previously');
  });
});

describe('alertText: the layout of every kind', () => {
  it('FAILED', () => {
    expect(alertText(input(), IDENTITY)).toBe([
      '🔴 <b>FAILED</b> send-and-receive-event',
      'instance prod | outage',
      '',
      '<b>event_visible</b> failed after 2m 0s',
      'class event_not_found | culprit hawk',
      'Event did not appear within 2m 0s: API answered 20 times, failed 3 times',
      '',
      'run #12 raaaaaaaaaaaaaaaa',
      'started 2026-03-10 12:00:00 UTC',
      '',
      'event latency 2.1 s',
      'before: collector_availability 120 ms, api_availability 340 ms, collector_accept 80 ms',
    ].join('\n'));
  });

  it('STILL FAILING', () => {
    expect(alertText(input({ kind: 'still_failing',
      row: failedRow({ eventLatencyMs: undefined,
        failedStage: 'collector_availability',
        errorClass: 'collector_unavailable',
        message: 'Collector http://collector:3000/health did not respond: TIMEOUT, waited 10.0 s',
        stages: [{ name: 'collector_availability',
          status: 'failed',
          durationMs: 10_001 },
        { name: 'api_availability',
          status: 'skipped',
          durationMs: 0 },
        { name: 'cleanup',
          status: 'skipped',
          durationMs: 0 }] }),
      state: stateRow({ episodeStartedAt: new Date(Date.parse(NOW) - 1_800_000).toISOString(),
        reported: ['event_visible/event_not_found', 'collector_availability/collector_unavailable'] }) }), IDENTITY)).toBe([
      '🟠 <b>STILL FAILING</b> send-and-receive-event',
      'instance prod | outage',
      '',
      '<b>collector_availability</b> failed after 10.0 s',
      'class collector_unavailable | culprit hawk',
      'previously: event_visible / event_not_found | failing for 30m 0s',
      'Collector http://collector:3000/health did not respond: TIMEOUT, waited 10.0 s',
      '',
      'run #12 raaaaaaaaaaaaaaaa',
      'started 2026-03-10 12:00:00 UTC',
    ].join('\n'));
  });

  it('RECOVERED', () => {
    expect(alertText(input({ kind: 'recovered',
      now: '2026-03-10T12:04:15.000Z',
      row: failedRow({ status: 'ok',
        sequence: 13,
        runId: 'rqzpwmahxkvtnbcd',
        errorClass: undefined,
        culprit: undefined,
        failedStage: undefined,
        message: undefined,
        eventLatencyMs: 21,
        stages: [{ name: 'collector_availability',
          status: 'ok',
          durationMs: 5 },
        { name: 'api_availability',
          status: 'ok',
          durationMs: 16 },
        { name: 'collector_accept',
          status: 'ok',
          durationMs: 3 },
        { name: 'event_visible',
          status: 'ok',
          durationMs: 25 },
        { name: 'cleanup',
          status: 'ok',
          durationMs: 5000 }] }),
      state: stateRow({ state: 'ok',
        episodeFailures: 1 }) }), IDENTITY)).toBe([
      '🟢 <b>RECOVERED</b> send-and-receive-event',
      'instance prod',
      '',
      'after 1 failed run, down 4m 15s',
      '(since 2026-03-10 12:00:00 UTC)',
      '',
      'run #13 rqzpwmahxkvtnbcd',
      'started 2026-03-10 12:00:00 UTC',
      '',
      'event latency 21 ms',
      'stages: collector_availability 5 ms, api_availability 16 ms, collector_accept 3 ms, event_visible 25 ms, cleanup 5.0 s',
    ].join('\n'));
  });

  it('RECOVERED, degraded', () => {
    expect(alertText(input({ kind: 'recovered_degraded',
      row: failedRow({ status: 'ok',
        errorClass: undefined,
        eventLatencyMs: undefined,
        stages: [{ name: 'cleanup',
          status: 'ok',
          durationMs: 900 }] }),
      state: stateRow({ state: 'degraded',
        degraded: ['single_channel'] }),
      result: notificationResult({ warnings: ['Only the webhook notification arrived'] }) }), IDENTITY)).toBe([
      '🟢 <b>RECOVERED, degraded</b> send-and-receive-event',
      'instance prod',
      '',
      'after 3 failed runs, down 1h 5m 3s',
      '(since 2026-03-10 12:00:00 UTC)',
      '',
      'degraded: single_channel',
      'Only the webhook notification arrived',
      '',
      'run #12 raaaaaaaaaaaaaaaa',
      'started 2026-03-10 12:00:00 UTC',
      '',
      'webhook 3.4 s | loop 3.6 s',
      'stages: cleanup 900 ms',
    ].join('\n'));
  });

  it('DEGRADED', () => {
    expect(alertText(input({ kind: 'degraded',
      row: failedRow({ status: 'ok',
        errorClass: undefined,
        eventLatencyMs: undefined,
        degraded: ['quota_usage'],
        stages: [{ name: 'cleanup',
          status: 'ok',
          durationMs: 900 }] }),
      state: stateRow({ state: 'degraded',
        degraded: ['quota_usage'] }),
      result: runResultFixture({ warnings: ['Event quota is almost used: 940/1000'] }) }), IDENTITY)).toBe([
      '🟡 <b>DEGRADED</b> send-and-receive-event',
      'instance prod | warning',
      '',
      'degraded: quota_usage',
      'Event quota is almost used: 940/1000',
      '',
      'run #12 raaaaaaaaaaaaaaaa',
      'started 2026-03-10 12:00:00 UTC',
      '',
      'stages: cleanup 900 ms',
    ].join('\n'));
  });

  it('STORAGE FAILING', () => {
    expect(storageFailingText('prod', 'disk full', IDENTITY)).toBe([
      '⚠️ <b>STORAGE FAILING</b>',
      'instance prod',
      '',
      'disk full',
    ].join('\n'));
  });

  it('a plain alert for a text that could not be built', () => {
    expect(plainAlertText('failed', 'check-notification', 'prod')).toBe([
      '🔴 <b>FAILED</b> check-notification',
      'instance prod',
      '',
      'The alert text could not be built, see the monitor log.',
    ].join('\n'));
  });
});

describe('alertText', () => {
  it('adds the notification latencies from the result', () => {
    const text = alertText(input({ result: notificationResult() }), IDENTITY);

    expect(lines(text)).toContain('event latency 2.1 s | webhook 3.4 s | loop 3.6 s');
  });

  it('writes durations for people: milliseconds below a second, one decimal below a minute', () => {
    const row = failedRow({ eventLatencyMs: 2100.6,
      stages: [{ name: 'collector_availability',
        status: 'failed',
        durationMs: 710.652_002 }],
      failedStage: 'collector_availability' });
    const text = lines(alertText(input({ row }), IDENTITY));

    expect(text).toContain('<b>collector_availability</b> failed after 711 ms');
    expect(text).toContain('event latency 2.1 s');
  });

  it('leaves the latency line out when there is no data', () => {
    const text = alertText(input({ row: failedRow({ eventLatencyMs: undefined }) }), IDENTITY);

    expect(text).not.toContain('latency');
  });

  it('leaves out the before line when no stage ran before the failed one', () => {
    const text = alertText(input({ row: failedRow({ eventLatencyMs: undefined,
      failedStage: 'collector_availability',
      stages: [{ name: 'collector_availability',
        status: 'failed',
        durationMs: 5 }] }) }), IDENTITY);

    expect(text).not.toContain('before');
  });

  it('quota_exhausted and rate_limited are warnings', () => {
    for (const errorClass of ['quota_exhausted', 'rate_limited'] as const) {
      expect(lines(alertText(input({ row: failedRow({ errorClass }) }), IDENTITY))[1]).toBe('instance prod | warning');
    }
  });

  it('a run without a failed stage says the run failed', () => {
    const text = alertText(input({ row: failedRow({ status: 'aborted',
      errorClass: 'run_hung',
      culprit: 'monitor',
      failedStage: undefined }) }), IDENTITY);

    expect(lines(text)).toContain('<b>run</b> failed');
    expect(lines(text)).toContain('class run_hung | culprit monitor');
  });

  it('RECOVERED singular and a short episode in seconds', () => {
    const text = alertText(input({ kind: 'recovered',
      now: '2026-03-10T12:00:42.000Z',
      state: stateRow({ state: 'ok',
        episodeFailures: 1 }) }), IDENTITY);

    expect(text).toContain('after 1 failed run, down 42.0 s');
  });

  it('RECOVERED from a degraded state has no episode line', () => {
    const text = alertText(input({ kind: 'recovered',
      state: stateRow({ state: 'ok',
        episodeStartedAt: undefined,
        episodeFailures: 0 }) }), IDENTITY);

    expect(text).not.toContain('after');
  });

  it.each(['degraded', 'recovered_degraded'] as const)('cuts long warnings of a %s alert to the limit and keeps the codes and the run line', (kind) => {
    const warnings = Array.from({ length: 5 }, (_, index) => `warning ${String(index)} ${'w&'.repeat(1500)}`);
    const text = alertText(input({ kind,
      row: failedRow({ status: 'ok',
        errorClass: undefined }),
      state: stateRow({ state: 'degraded',
        degraded: ['quota_usage'] }),
      result: runResultFixture({ warnings }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(text).toContain('degraded: quota_usage');
    expect(text).toContain('run #12 raaaaaaaaaaaaaaaa');
    expect(text).toContain('warning 0');
  });

  it('escapes < and & in the instance, the message and the stages, not the markup', () => {
    const text = alertText(input({ instanceId: 'a<b&c',
      row: failedRow({ message: 'Title <script> & "x"' }) }), IDENTITY);

    expect(lines(text)[1]).toBe('instance a&lt;b&amp;c | outage');
    expect(text).toContain('Title &lt;script&gt; &amp; "x"');
    expect(text).not.toContain('<script>');
  });

  it('masks secrets in the message before anything else', () => {
    const redact = createRedactor(['hunter2-secret']);
    const text = alertText(input({ row: failedRow({ message: 'token hunter2-secret rejected' }) }), redact);

    expect(text).not.toContain('hunter2-secret');
    expect(text).toContain('token *** rejected');
  });

  it('masks the instance and the text of a storage alert', () => {
    const redact = createRedactor(['hunter2-secret']);

    expect(storageFailingText('hunter2-secret', 'locked by hunter2-secret', redact)).not.toContain('hunter2-secret');
  });

  it('cuts a long message so that the escaped text fits the limit and ends with an ellipsis', () => {
    const text = alertText(input({ row: failedRow({ message: 'x'.repeat(10_000) }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(text.length).toBeGreaterThan(ALERT_TEXT_LIMIT - 5);
    expect(text).toContain('x…\n');
    expect(text).toContain('before: collector_availability 120 ms');
    expect(text).toContain('<b>event_visible</b> failed after 2m 0s');
  });

  it('never cuts an entity: a message of ampersands ends in a whole &amp;', () => {
    for (const extra of [0, 1, 2, 3, 4]) {
      const text = alertText(input({ row: failedRow({ message: '&'.repeat(5000 + extra) }) }), IDENTITY);
      const message = lines(text).find(line => line.startsWith('&amp;')) ?? '';

      expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
      expect(message.endsWith('&amp;…')).toBe(true);
      expect(message.replaceAll('&amp;', '').replace('…', '')).toBe('');
    }
  });

  it('cuts the stages line once the message is down to an ellipsis, and never the header or the failed stage', () => {
    const stages = Array.from({ length: 400 }, (_, index) => ({ name: 'cleanup' as const,
      status: 'ok' as const,
      durationMs: index }));
    const text = alertText(input({ row: failedRow({ message: 'short',
      stages: [...stages, { name: 'event_visible',
        status: 'failed',
        durationMs: 5 }] }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(lines(text)[0]).toBe('🔴 <b>FAILED</b> send-and-receive-event');
    expect(lines(text)).toContain('<b>event_visible</b> failed after 5 ms');
    expect(lines(text)).toContain('…');
    expect(lines(text).find(line => line.startsWith('before:'))
      ?.endsWith('…')).toBe(true);
  });

  it('keeps a text of fewer than 3500 characters whole', () => {
    const text = alertText(input(), IDENTITY);

    expect(text).not.toContain('…');
  });
});
