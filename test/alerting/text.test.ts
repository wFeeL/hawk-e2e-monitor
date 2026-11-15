import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/errors/redact.js';
import type { RunResult } from '../../src/engine/result.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import type { AlertStateRow } from '../../src/storage/history.js';
import type { RunRow } from '../../src/storage/types.js';
import { ALERT_TEXT_LIMIT, alertText, escapeHtml } from '../../src/alerting/text.js';
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
    message: 'Event did not appear within 120000 ms',
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

describe('alertText', () => {
  it('FAILED has every line of the format', () => {
    expect(lines(alertText(input(), IDENTITY))).toEqual([
      '<b>FAILED</b> send-and-receive-event [e2e:prod] | outage',
      'stage: event_visible | class: event_not_found | culprit: hawk',
      'Event did not appear within 120000 ms',
      'run: raaaaaaaaaaaaaaaa #12 | 2026-03-10T12:00:00.000Z',
      'stages: collector_availability 120 ms ok, api_availability 340 ms ok, collector_accept 80 ms ok, event_visible 120000 ms failed, cleanup 900 ms ok',
      'event latency: 2100 ms',
    ]);
  });

  it('adds the notification latencies from the result', () => {
    const text = alertText(input({ result: notificationResult() }), IDENTITY);

    expect(lines(text).at(-1)).toBe('event latency: 2100 ms | webhook 3400 ms | loop 3600 ms');
  });

  it('rounds stage durations and latencies to whole milliseconds', () => {
    const row = failedRow({ eventLatencyMs: 2100.6,
      stages: [{ name: 'collector_availability',
        status: 'failed',
        durationMs: 710.652_002 }] });
    const result = notificationResult({ notification: { webhook: { latencyMs: 3400.49 },
      loop: { latencyMs: 3600.5 },
      unmatched: 0 } });
    const text = lines(alertText(input({ row,
      result }), IDENTITY));

    expect(text).toContain('stages: collector_availability 711 ms failed');
    expect(text.at(-1)).toBe('event latency: 2101 ms | webhook 3400 ms | loop 3601 ms');
  });

  it('leaves the latency line out when there is no data', () => {
    const text = alertText(input({ row: failedRow({ eventLatencyMs: undefined }) }), IDENTITY);

    expect(text).not.toContain('latency');
  });

  it('STILL FAILING has its own header and the same body', () => {
    const text = alertText(input({ kind: 'still_failing' }), IDENTITY);

    expect(lines(text)[0]).toBe('<b>STILL FAILING, now</b> send-and-receive-event [e2e:prod] | outage');
    expect(lines(text)[1]).toContain('class: event_not_found');
  });

  it('quota_exhausted and rate_limited are warnings', () => {
    for (const errorClass of ['quota_exhausted', 'rate_limited'] as const) {
      expect(lines(alertText(input({ row: failedRow({ errorClass }) }), IDENTITY))[0]).toMatch(/\| warning$/u);
    }
  });

  it('a run without a failed stage prints a dash', () => {
    const text = alertText(input({ row: failedRow({ status: 'aborted',
      errorClass: 'run_hung',
      culprit: 'monitor',
      failedStage: undefined }) }), IDENTITY);

    expect(lines(text)[1]).toBe('stage: - | class: run_hung | culprit: monitor');
  });

  it('RECOVERED names the failed runs and the length of the episode', () => {
    const text = alertText(input({ kind: 'recovered',
      row: failedRow({ status: 'ok',
        errorClass: undefined }),
      state: stateRow({ state: 'ok' }) }), IDENTITY);

    expect(lines(text)[0]).toBe('<b>RECOVERED</b> send-and-receive-event [e2e:prod]');
    expect(text).toContain('after 3 failed runs, 1h 5m 3s (since 2026-03-10T12:00:00.000Z)');
    expect(text).toContain('run: raaaaaaaaaaaaaaaa #12');
  });

  it('RECOVERED with one failed run is singular and short episodes print seconds', () => {
    const text = alertText(input({ kind: 'recovered',
      now: '2026-03-10T12:00:42.000Z',
      state: stateRow({ state: 'ok',
        episodeFailures: 1 }) }), IDENTITY);

    expect(text).toContain('after 1 failed run, 42s (since');
  });

  it('RECOVERED from a degraded state has no episode line', () => {
    const text = alertText(input({ kind: 'recovered',
      state: stateRow({ state: 'ok',
        episodeStartedAt: undefined,
        episodeFailures: 0 }) }), IDENTITY);

    expect(text).not.toContain('after');
  });

  it('RECOVERED, degraded adds the codes and the warnings', () => {
    const text = alertText(input({ kind: 'recovered_degraded',
      state: stateRow({ state: 'degraded',
        degraded: ['single_channel'] }),
      result: notificationResult({ warnings: ['Only the webhook notification arrived'] }) }), IDENTITY);

    expect(lines(text)[0]).toBe('<b>RECOVERED, degraded</b> send-and-receive-event [e2e:prod]');
    expect(text).toContain('after 3 failed runs');
    expect(text).toContain('degraded: single_channel');
    expect(text).toContain('Only the webhook notification arrived');
  });

  it('DEGRADED has a warning level, the codes and the warnings', () => {
    const text = alertText(input({ kind: 'degraded',
      row: failedRow({ status: 'ok',
        errorClass: undefined,
        degraded: ['quota_projection'] }),
      state: stateRow({ state: 'degraded',
        degraded: ['quota_projection'] }),
      result: runResultFixture({ warnings: ['Event quota is almost used: 9/10'] }) }), IDENTITY);

    expect(lines(text)[0]).toBe('<b>DEGRADED</b> send-and-receive-event [e2e:prod] | warning');
    expect(text).toContain('degraded: quota_projection');
    expect(text).toContain('Event quota is almost used: 9/10');
  });

  it.each(['degraded', 'recovered_degraded'] as const)('cuts long warnings of a %s alert to the limit and keeps the codes and the run line', (kind) => {
    const warnings = Array.from({ length: 5 }, (_, index) => `warning ${String(index)} ${'w&'.repeat(1500)}`);
    const text = alertText(input({ kind,
      row: failedRow({ status: 'ok',
        errorClass: undefined }),
      state: stateRow({ state: 'degraded',
        degraded: ['quota_projection'] }),
      result: runResultFixture({ warnings }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(text).toContain('degraded: quota_projection');
    expect(text).toContain('run: raaaaaaaaaaaaaaaa #12');
    expect(text).toContain('warning 0');
  });

  it('escapes < and & in the instance, the message and the stage line, not the markup', () => {
    const text = alertText(input({ instanceId: 'a<b&c',
      row: failedRow({ message: 'Title <script> & "x"' }) }), IDENTITY);

    expect(lines(text)[0]).toBe('<b>FAILED</b> send-and-receive-event [e2e:a&lt;b&amp;c] | outage');
    expect(text).toContain('Title &lt;script&gt; &amp; "x"');
    expect(text).not.toContain('<script>');
  });

  it('masks secrets in the message before anything else', () => {
    const redact = createRedactor(['hunter2-secret']);
    const text = alertText(input({ row: failedRow({ message: 'token hunter2-secret rejected' }) }), redact);

    expect(text).not.toContain('hunter2-secret');
    expect(text).toContain('token *** rejected');
  });

  it('cuts a long message so that the escaped text fits the limit and ends with an ellipsis', () => {
    const text = alertText(input({ row: failedRow({ message: 'x'.repeat(10_000) }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(text.length).toBeGreaterThan(ALERT_TEXT_LIMIT - 5);
    expect(text).toContain('x…\n');
    expect(text).toContain('stages: collector_availability 120 ms ok');
  });

  it('never cuts an entity: a message of ampersands ends in a whole &amp;', () => {
    for (const extra of [0, 1, 2, 3, 4]) {
      const text = alertText(input({ row: failedRow({ message: '&'.repeat(5000 + extra) }) }), IDENTITY);
      const message = lines(text)[2] ?? '';

      expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
      expect(message.endsWith('&amp;…')).toBe(true);
      expect(message.replaceAll('&amp;', '').replace('…', '')).toBe('');
    }
  });

  it('cuts the stage line once the message is down to an ellipsis', () => {
    const stages = Array.from({ length: 400 }, (_, index) => ({ name: 'cleanup' as const,
      status: 'ok' as const,
      durationMs: index }));
    const text = alertText(input({ row: failedRow({ message: 'short',
      stages }) }), IDENTITY);

    expect(text.length).toBeLessThanOrEqual(ALERT_TEXT_LIMIT);
    expect(lines(text)[2]).toBe('…');
    expect(lines(text).find(line => line.startsWith('stages:'))
      ?.endsWith('…')).toBe(true);
  });

  it('keeps a text of fewer than 3500 characters whole', () => {
    const text = alertText(input(), IDENTITY);

    expect(text).not.toContain('…');
  });
});
