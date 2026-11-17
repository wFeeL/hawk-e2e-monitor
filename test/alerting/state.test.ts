import { describe, expect, it } from 'vitest';
import type { AlertStateRow } from '../../src/storage/types.js';
import type { DegradedCode } from '../../src/engine/result.js';
import type { RunRow } from '../../src/storage/types.js';
import { decideAlert } from '../../src/alerting/state.js';

const NOW = '2026-03-10T12:00:00.000Z';
const BEFORE = '2026-03-10T11:00:00.000Z';
const SCENARIO = 'send-and-receive-event';
const SETTINGS = { alertAfterFailures: 1 };

/**
 * Builds a finished run row.
 * @param overrides Fields that replace an `ok` run.
 * @returns Run row.
 */
function row(overrides: Partial<RunRow> = {}): RunRow {
  return { id: 1,
    runId: 'raaaaaaaaaaaaaaaa',
    scenario: SCENARIO,
    sequence: 1,
    trigger: 'schedule',
    status: 'ok',
    startedAt: '2026-03-10T11:59:00.000Z',
    finishedAt: NOW,
    durationMs: 1000,
    degraded: [],
    stages: [],
    ...overrides };
}

/**
 * Builds a failed run row.
 * @param errorClass Class of the failure.
 * @param failedStage Stage of the failure.
 * @returns Run row.
 */
function failed(errorClass: RunRow['errorClass'] = 'event_not_found', failedStage: RunRow['failedStage'] = 'event_visible'): RunRow {
  return row({ status: 'failed',
    errorClass,
    failedStage,
    culprit: 'hawk' });
}

/**
 * Builds a stored state.
 * @param overrides Fields that replace an idle `ok` state.
 * @returns Alert state.
 */
function state(overrides: Partial<AlertStateRow> = {}): AlertStateRow {
  return { scenario: SCENARIO,
    state: 'ok',
    failureStreak: 0,
    episodeFailures: 0,
    degraded: [],
    updatedAt: BEFORE,
    ...overrides };
}

const FAILING = state({ state: 'failing',
  failureStreak: 2,
  lastClass: 'event_not_found',
  lastStage: 'event_visible',
  lastRunId: 'rbbbbbbbbbbbbbbbb',
  episodeStartedAt: '2026-03-10T11:00:00.000Z',
  episodeFailures: 2 });

describe('decideAlert: failures', () => {
  it('ok to failing sends FAILED and opens the episode', () => {
    const decision = decideAlert(state(), failed(), SETTINGS, NOW);

    expect(decision.kind).toBe('failed');
    expect(decision.state).toEqual({ scenario: SCENARIO,
      state: 'failing',
      failureStreak: 1,
      lastClass: 'event_not_found',
      lastStage: 'event_visible',
      lastRunId: 'raaaaaaaaaaaaaaaa',
      episodeStartedAt: '2026-03-10T11:59:00.000Z',
      episodeFailures: 1,
      degraded: [],
      updatedAt: NOW });
  });

  it('a first run without any stored state starts from ok', () => {
    expect(decideAlert(undefined, failed(), SETTINGS, NOW)).toMatchObject({ kind: 'failed',
      state: { state: 'failing',
        scenario: SCENARIO } });
    expect(decideAlert(undefined, row(), SETTINGS, NOW)).toEqual({ state: state({ updatedAt: NOW }) });
  });

  it('degraded to failing sends FAILED', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'] }), failed(), SETTINGS, NOW);

    expect(decision.kind).toBe('failed');
    expect(decision.state.state).toBe('failing');
  });

  it('failing to failing with the same class and stage is silent but counts', () => {
    const decision = decideAlert(FAILING, failed(), SETTINGS, NOW);

    expect(decision.kind).toBeUndefined();
    expect(decision.state).toMatchObject({ state: 'failing',
      failureStreak: 3,
      episodeFailures: 3,
      episodeStartedAt: FAILING.episodeStartedAt,
      lastRunId: 'raaaaaaaaaaaaaaaa' });
  });

  it('failing to failing with another class sends STILL FAILING', () => {
    const decision = decideAlert(FAILING, failed('collector_unavailable', 'collector_availability'), SETTINGS, NOW);

    expect(decision.kind).toBe('still_failing');
    expect(decision.state).toMatchObject({ lastClass: 'collector_unavailable',
      lastStage: 'collector_availability',
      episodeFailures: 3 });
  });

  it('failing to failing with the same class on another stage sends STILL FAILING', () => {
    expect(decideAlert(FAILING, failed('event_not_found', 'cleanup'), SETTINGS, NOW).kind).toBe('still_failing');
  });

  it('a hung or internally failed run counts as a failure', () => {
    expect(decideAlert(state(), row({ status: 'aborted',
      errorClass: 'run_hung' }), SETTINGS, NOW).kind).toBe('failed');
    expect(decideAlert(state(), row({ status: 'aborted',
      errorClass: 'monitor_internal' }), SETTINGS, NOW).kind).toBe('failed');
  });

  it('the threshold of 2 is silent on the first failure and fires on the second', () => {
    const settings = { alertAfterFailures: 2 };
    const first = decideAlert(state(), failed(), settings, NOW);

    expect(first.kind).toBeUndefined();
    expect(first.state).toMatchObject({ state: 'ok',
      failureStreak: 1 });

    const second = decideAlert(first.state, failed(), settings, NOW);

    expect(second.kind).toBe('failed');
    expect(second.state).toMatchObject({ state: 'failing',
      failureStreak: 2,
      episodeFailures: 2,
      episodeStartedAt: '2026-03-10T11:59:00.000Z' });
  });

  it('a success before the threshold resets the streak', () => {
    const settings = { alertAfterFailures: 2 };
    const first = decideAlert(state(), failed(), settings, NOW).state;

    expect(decideAlert(first, row(), settings, NOW).state.failureStreak).toBe(0);
  });

  it('a failure below the threshold keeps the degraded state', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'] }), failed(), { alertAfterFailures: 2 }, NOW);

    expect(decision.kind).toBeUndefined();
    expect(decision.state).toMatchObject({ state: 'degraded',
      failureStreak: 1 });
  });
});

describe('decideAlert: successes', () => {
  it('failing to ok sends RECOVERED and keeps the episode for the text', () => {
    const decision = decideAlert(FAILING, row(), SETTINGS, NOW);

    expect(decision.kind).toBe('recovered');
    expect(decision.state).toMatchObject({ state: 'ok',
      failureStreak: 0,
      episodeStartedAt: FAILING.episodeStartedAt,
      episodeFailures: 2,
      degraded: [] });
  });

  it('failing to degraded sends RECOVERED, degraded', () => {
    const decision = decideAlert(FAILING, row({ degraded: ['single_channel'] }), SETTINGS, NOW);

    expect(decision.kind).toBe('recovered_degraded');
    expect(decision.state).toMatchObject({ state: 'degraded',
      degraded: ['single_channel'],
      episodeFailures: 2 });
  });

  it('ok to degraded sends DEGRADED', () => {
    const decision = decideAlert(state(), row({ degraded: ['quota_usage'] }), SETTINGS, NOW);

    expect(decision.kind).toBe('degraded');
    expect(decision.state).toMatchObject({ state: 'degraded',
      degraded: ['quota_usage'] });
  });

  it('degraded to ok sends RECOVERED without an episode', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'],
      episodeStartedAt: '2026-03-10T10:00:00.000Z',
      episodeFailures: 4 }), row(), SETTINGS, NOW);

    expect(decision.kind).toBe('recovered');
    expect(decision.state.episodeStartedAt).toBeUndefined();
    expect(decision.state.episodeFailures).toBe(0);
  });

  it('degraded to degraded with other codes sends DEGRADED, with the same codes nothing', () => {
    const before = state({ state: 'degraded',
      degraded: ['single_channel'] });

    expect(decideAlert(before, row({ degraded: ['single_channel', 'quota_usage'] }), SETTINGS, NOW).kind).toBe('degraded');
    expect(decideAlert(before, row({ degraded: ['quota_usage'] }), SETTINGS, NOW).kind).toBe('degraded');
    expect(decideAlert(before, row({ degraded: ['single_channel'] }), SETTINGS, NOW).kind).toBeUndefined();

    const both = state({ state: 'degraded',
      degraded: ['single_channel', 'quota_usage'] });
    const reordered: DegradedCode[] = ['quota_usage', 'single_channel'];

    expect(decideAlert(both, row({ degraded: reordered }), SETTINGS, NOW).kind).toBeUndefined();
  });

  it('ok to ok is silent', () => {
    expect(decideAlert(state(), row(), SETTINGS, NOW).kind).toBeUndefined();
  });
});

describe('decideAlert: runs that change nothing', () => {
  it.each([
    ['skipped', row({ status: 'skipped',
      skipReason: 'rule_cache_warmup' })],
    ['skipped overlap', row({ status: 'skipped',
      skipReason: 'overlap' })],
    ['aborted monitor_stopped', row({ status: 'aborted',
      errorClass: 'monitor_stopped' })],
    ['aborted monitor_restarted', row({ status: 'aborted',
      errorClass: 'monitor_restarted' })],
  ])('%s leaves the state and the updated time alone', (_name, run) => {
    for (const before of [state(), FAILING, state({ state: 'degraded',
      degraded: ['single_channel'] })]) {
      expect(decideAlert(before, run, SETTINGS, NOW)).toEqual({ state: before });
    }
  });
});
