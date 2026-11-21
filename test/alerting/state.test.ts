import { describe, expect, it } from 'vitest';
import type { AlertStateRow } from '../../src/storage/types.js';
import type { DegradedCode } from '../../src/engine/result.js';
import type { RunRow } from '../../src/storage/types.js';
import { REPEAT_STAGES, VARIANT_STAGES, covers, decideAlert, pairOf, plannedTransport, producedTransports, shareEpisode } from '../../src/alerting/state.js';
import { chooseTransport, shouldRepeat } from '../../src/scenarios/shared/plan.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
import type { StageName } from '../../src/engine/result.js';
import type { StageRow } from '../../src/storage/types.js';
import type { AlertSettings } from '../../src/alerting/state.js';

const NOW = '2026-03-10T12:00:00.000Z';
const BEFORE = '2026-03-10T11:00:00.000Z';
const SCENARIO = 'send-and-receive-event';
const HTTP = { transport: 'http' } as const;
const WS = { transport: 'ws' } as const;

/**
 * Builds the settings of the decision.
 * @param alertAfterFailures Failed runs in a row that raise the alert.
 * @param overrides Other fields.
 * @returns Settings with repeats on and alternating transports by default.
 */
function settingsOf(alertAfterFailures: number, overrides: Partial<AlertSettings> = {}): AlertSettings {
  return { alertAfterFailures,
    repeatsOn: true,
    transportMode: 'alternate',
    ...overrides };
}

const SETTINGS = settingsOf(1);

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
    open: [],
    announced: true,
    reported: [],
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
    const decision = decideAlert(state(), failed(), SETTINGS, NOW, HTTP);

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
      open: [{ pair: 'event_visible@http',
        count: 1,
        firstAt: '2026-03-10T11:59:00.000Z' }],
      announced: true,
      streakStartedAt: '2026-03-10T11:59:00.000Z',
      reported: ['event_visible/event_not_found'],
      updatedAt: NOW });
  });

  it('a first run without any stored state starts from ok', () => {
    expect(decideAlert(undefined, failed(), SETTINGS, NOW, HTTP)).toMatchObject({ kind: 'failed',
      state: { state: 'failing',
        scenario: SCENARIO } });
    expect(decideAlert(undefined, row(), SETTINGS, NOW, HTTP)).toEqual({ state: state({ updatedAt: NOW }) });
  });

  it('degraded to failing sends FAILED', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'] }), failed(), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('failed');
    expect(decision.state.state).toBe('failing');
  });

  it('failing to failing with the same class and stage is silent but counts', () => {
    const decision = decideAlert(FAILING, failed(), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBeUndefined();
    expect(decision.state).toMatchObject({ state: 'failing',
      failureStreak: 3,
      episodeFailures: 3,
      episodeStartedAt: FAILING.episodeStartedAt,
      lastRunId: 'raaaaaaaaaaaaaaaa' });
  });

  it('failing to failing with another class sends STILL FAILING', () => {
    const decision = decideAlert(FAILING, failed('collector_unavailable', 'collector_availability'), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('still_failing');
    expect(decision.state).toMatchObject({ lastClass: 'collector_unavailable',
      lastStage: 'collector_availability',
      episodeFailures: 3 });
  });

  it('failing to failing with the same class on another stage sends STILL FAILING', () => {
    expect(decideAlert(FAILING, failed('event_not_found', 'cleanup'), SETTINGS, NOW, HTTP).kind).toBe('still_failing');
  });

  it('a hung or internally failed run counts as a failure', () => {
    expect(decideAlert(state(), row({ status: 'aborted',
      errorClass: 'run_hung' }), SETTINGS, NOW, HTTP).kind).toBe('failed');
    expect(decideAlert(state(), row({ status: 'aborted',
      errorClass: 'monitor_internal' }), SETTINGS, NOW, HTTP).kind).toBe('failed');
  });

  it('the threshold of 2 is silent on the first failure and fires on the second', () => {
    const settings = settingsOf(2);
    const first = decideAlert(state(), failed(), settings, NOW, HTTP);

    expect(first.kind).toBeUndefined();
    expect(first.state).toMatchObject({ state: 'ok',
      failureStreak: 1 });

    const second = decideAlert(first.state, failed(), settings, NOW, HTTP);

    expect(second.kind).toBe('failed');
    expect(second.state).toMatchObject({ state: 'failing',
      failureStreak: 2,
      episodeFailures: 2,
      episodeStartedAt: '2026-03-10T11:59:00.000Z' });
  });

  it('a success before the threshold resets the streak', () => {
    const settings = settingsOf(2);
    const first = decideAlert(state(), failed(), settings, NOW, HTTP).state;

    expect(decideAlert(first, row(), settings, NOW, HTTP).state.failureStreak).toBe(0);
  });

  it('a failure below the threshold keeps the degraded state', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'] }), failed(), settingsOf(2), NOW, HTTP);

    expect(decision.kind).toBeUndefined();
    expect(decision.state).toMatchObject({ state: 'degraded',
      failureStreak: 1 });
  });
});

describe('decideAlert: successes', () => {
  it('failing to ok sends RECOVERED and keeps the episode for the text', () => {
    const decision = decideAlert(FAILING, row(), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('recovered');
    expect(decision.state).toMatchObject({ state: 'ok',
      failureStreak: 0,
      episodeStartedAt: FAILING.episodeStartedAt,
      episodeFailures: 2,
      degraded: [] });
  });

  it('failing to degraded sends RECOVERED, degraded', () => {
    const decision = decideAlert(FAILING, row({ degraded: ['single_channel'] }), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('recovered_degraded');
    expect(decision.state).toMatchObject({ state: 'degraded',
      degraded: ['single_channel'],
      episodeFailures: 2 });
  });

  it('ok to degraded sends DEGRADED', () => {
    const decision = decideAlert(state(), row({ degraded: ['quota_usage'] }), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('degraded');
    expect(decision.state).toMatchObject({ state: 'degraded',
      degraded: ['quota_usage'] });
  });

  it('degraded to ok sends RECOVERED without an episode', () => {
    const decision = decideAlert(state({ state: 'degraded',
      degraded: ['single_channel'],
      episodeStartedAt: '2026-03-10T10:00:00.000Z',
      episodeFailures: 4 }), row(), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('recovered');
    expect(decision.state.episodeStartedAt).toBeUndefined();
    expect(decision.state.episodeFailures).toBe(0);
  });

  it('degraded to degraded with other codes sends DEGRADED, with the same codes nothing', () => {
    const before = state({ state: 'degraded',
      degraded: ['single_channel'] });

    expect(decideAlert(before, row({ degraded: ['single_channel', 'quota_usage'] }), SETTINGS, NOW, HTTP).kind).toBe('degraded');
    expect(decideAlert(before, row({ degraded: ['quota_usage'] }), SETTINGS, NOW, HTTP).kind).toBe('degraded');
    expect(decideAlert(before, row({ degraded: ['single_channel'] }), SETTINGS, NOW, HTTP).kind).toBeUndefined();

    const both = state({ state: 'degraded',
      degraded: ['single_channel', 'quota_usage'] });
    const reordered: DegradedCode[] = ['quota_usage', 'single_channel'];

    expect(decideAlert(both, row({ degraded: reordered }), SETTINGS, NOW, HTTP).kind).toBeUndefined();
  });

  it('ok to ok is silent', () => {
    expect(decideAlert(state(), row(), SETTINGS, NOW, HTTP).kind).toBeUndefined();
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
      expect(decideAlert(before, run, SETTINGS, NOW, HTTP)).toEqual({ state: before });
    }
  });
});

const DONE = 5;

/** Where a run sent its event. */
interface Where {
  /** Transport of the run. */
  transport: 'http' | 'ws' | '*';
}

/** What `play` returns. */
interface Played {
  /** Message kinds in order. */
  kinds: Array<string | undefined>;
  /** State after the last run. */
  last: AlertStateRow;
}

/**
 * Builds a stage row.
 * @param name Stage that ran.
 * @param status How it ended.
 * @returns Stage row.
 */
function stage(name: StageName, status: StageRow['status'] = 'ok'): StageRow {
  return { name,
    status,
    durationMs: DONE };
}

/**
 * Builds a finished `ok` run row with stages.
 * @param stages Stages of the run.
 * @param overrides Other fields.
 * @returns Run row.
 */
function passed(stages: StageRow[], overrides: Partial<RunRow> = {}): RunRow {
  return row({ stages,
    ...overrides });
}

/**
 * Builds a failed run row with stages.
 * @param at Stage that failed.
 * @param stages Stages of the run.
 * @param overrides Other fields.
 * @returns Run row.
 */
function failedAt(at: StageName, stages: StageRow[] = [], overrides: Partial<RunRow> = {}): RunRow {
  return row({ status: 'failed',
    errorClass: 'event_not_found',
    failedStage: at,
    culprit: 'hawk',
    stages: [...stages, stage(at, 'failed')],
    ...overrides });
}

/**
 * Applies runs one after another.
 * @param runs Run rows with their transport.
 * @param settings Settings of every decision.
 * @param start State before the first run.
 * @returns The kinds produced, in order, and the last state.
 */
function play(runs: ReadonlyArray<readonly [RunRow, Where]>, settings: AlertSettings, start: AlertStateRow = state()): Played {
  let current = start;
  const kinds: Array<string | undefined> = [];

  for (const [run, where] of runs) {
    const decision = decideAlert(current, run, settings, NOW, where);

    kinds.push(decision.kind);
    current = decision.state;
  }

  return { kinds,
    last: current };
}

describe('decideAlert: an episode closes when every failure is covered', () => {
  const visible = [stage('collector_availability'), stage('collector_accept'), stage('event_visible')];

  it('(a) event_visible@ws, an http success does not recover, a ws success does; threshold 1', () => {
    const { kinds, last } = play([
      [failedAt('event_visible', [stage('collector_availability'), stage('collector_accept')]), WS],
      [passed(visible), HTTP],
      [passed(visible), HTTP],
      [passed(visible), WS],
    ], SETTINGS);

    expect(kinds).toEqual(['failed', undefined, undefined, 'recovered']);
    expect(last.open).toEqual([]);
  });

  it('(a) event_visible@ws with threshold 2 fires on the third run across an http success', () => {
    const { kinds } = play([
      [failedAt('event_visible'), WS],
      [passed(visible), HTTP],
      [failedAt('event_visible'), WS],
    ], settingsOf(2));

    expect(kinds).toEqual([undefined, undefined, 'failed']);
  });

  it('(b) a repeat failure on ws and a collector_accept failure on http: only the ws repeat closes the first', () => {
    const base = [stage('collector_availability'), stage('collector_accept'), stage('event_visible')];
    const { kinds, last } = play([
      [failedAt('event_repeated', base), WS],
      [failedAt('collector_accept', [stage('collector_availability')]), HTTP],
      [passed([...base, stage('event_repeated', 'skipped')]), HTTP],
      [passed([...base, stage('event_repeated')]), WS],
    ], SETTINGS);

    expect(kinds).toEqual(['failed', 'still_failing', undefined, 'recovered']);
    expect(last.open).toEqual([]);
  });

  it('(c) telegram_probe is covered by a success that skipped it after a delivered message', () => {
    const decision = decideAlert(state({ scenario: 'telegram-delivery',
      state: 'failing',
      open: [{ pair: 'telegram_probe@*',
        count: 1 }] }), passed([stage('telegram_delivered'), stage('telegram_probe', 'skipped')], { scenario: 'telegram-delivery' }), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('recovered');
  });

  it('(d) a hung ws run is not covered by an http success', () => {
    const hung = row({ status: 'aborted',
      errorClass: 'run_hung' });
    const { kinds } = play([[hung, WS], [passed([]), HTTP], [passed([]), WS]], SETTINGS);

    expect(kinds).toEqual(['failed', undefined, 'recovered']);
  });

  it('(e) a success that covers nothing below the threshold still sends DEGRADED', () => {
    const before = state({ open: [{ pair: 'event_visible@ws',
      count: 1 }],
    streakStartedAt: BEFORE });
    const decision = decideAlert(before, passed(visible, { degraded: ['quota_usage'] }), settingsOf(2), NOW, HTTP);

    expect(decision.kind).toBe('degraded');
    expect(decision.state.open).toEqual(before.open);
  });

  it('(g) a stageless failure of sourcemaps is covered by its next success over http', () => {
    const hung = row({ scenario: 'sourcemaps',
      sequence: 2,
      status: 'aborted',
      errorClass: 'run_hung' });
    const { kinds } = play([[hung, HTTP], [passed([], { scenario: 'sourcemaps' }), HTTP]], SETTINGS, state({ scenario: 'sourcemaps' }));

    expect(kinds).toEqual(['failed', 'recovered']);
  });

  it('(h) threshold 2: a one-off repeat failure and a later one-off failure elsewhere do not fire', () => {
    const { kinds } = play([
      [failedAt('event_repeated'), WS],
      [passed(visible), HTTP],
      [passed(visible), WS],
      [failedAt('collector_accept'), HTTP],
    ], settingsOf(2));

    expect(kinds).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('(i) a ws pair is covered by any success once the mode is http', () => {
    const decision = decideAlert(state({ state: 'failing',
      open: [{ pair: 'event_visible@ws',
        count: 1 }] }), passed([]), settingsOf(1, { transportMode: 'http' }), NOW, HTTP);

    expect(decision.kind).toBe('recovered');
  });

  it('(j) a second failure of notification_formed does not close the episode', () => {
    const { kinds, last } = play([
      [failedAt('notification_formed', [], { scenario: 'telegram-delivery' }), HTTP],
      [failedAt('notification_formed', [], { scenario: 'telegram-delivery' }), HTTP],
    ], SETTINGS, state({ scenario: 'telegram-delivery' }));

    expect(kinds).toEqual(['failed', undefined]);
    expect(last.open).toMatchObject([{ pair: 'notification_formed@*',
      count: 2 }]);
  });

  it('a failed run removes the pairs it passed, so a stale availability pair does not outlive the outage', () => {
    const before = state({ state: 'failing',
      failureStreak: 1,
      open: [{ pair: 'collector_availability@*',
        count: 1 }] });
    const decision = decideAlert(before, failedAt('event_visible', [stage('collector_availability'), stage('collector_accept')]), SETTINGS, NOW, HTTP);

    expect(decision.state.open).toMatchObject([{ pair: 'event_visible@http',
      count: 1 }]);
    expect(decision.kind).toBe('still_failing');
  });

  it('a failed run does not cover a pair of the stage it failed at, nor one it never reached', () => {
    const failing = failedAt('event_visible', [stage('collector_availability')]);

    expect(covers('event_visible@http', failing, 'http', SETTINGS)).toBe(false);
    expect(covers('telegram_probe@*', failing, 'http', SETTINGS)).toBe(false);
    expect(covers('collector_availability@*', failing, 'http', SETTINGS)).toBe(true);
  });

  it('keeps the start of the series while pairs stay open and counts the episode by the open counts', () => {
    const { last } = play([
      [failedAt('event_visible'), WS],
      [passed(visible), HTTP],
      [failedAt('event_visible'), WS],
    ], settingsOf(2));

    expect(last).toMatchObject({ state: 'failing',
      episodeFailures: 2,
      streakStartedAt: '2026-03-10T11:59:00.000Z',
      open: [{ pair: 'event_visible@ws',
        count: 2 }] });
  });

  it('a success clears the series start and the reported causes once nothing stays open', () => {
    const decision = decideAlert(state({ state: 'failing',
      open: [{ pair: 'event_visible@http',
        count: 1 }],
      reported: ['event_visible/event_not_found'],
      streakStartedAt: BEFORE }), passed(visible), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBe('recovered');
    expect(decision.state).toMatchObject({ open: [],
      reported: [] });
    expect(decision.state.streakStartedAt).toBeUndefined();
  });

  it('a non-covering success of a failing state keeps it, resets the streak and says nothing', () => {
    const before = state({ state: 'failing',
      failureStreak: 4,
      lastClass: 'event_not_found',
      open: [{ pair: 'event_visible@ws',
        count: 4 }] });
    const decision = decideAlert(before, passed(visible, { degraded: ['quota_usage'] }), SETTINGS, NOW, HTTP);

    expect(decision.kind).toBeUndefined();
    expect(decision.state).toEqual({ ...before,
      failureStreak: 0,
      updatedAt: NOW });
  });
});

describe('transports of a scenario', () => {
  it('plans http for the forced scenarios, the alternation for the others and * for the probe', () => {
    expect(plannedTransport('sourcemaps', 2, 'alternate')).toBe('http');
    expect(plannedTransport('sentry-envelope', 2, 'alternate')).toBe('http');
    expect(plannedTransport('new-project', 2, 'ws')).toBe('http');
    expect(plannedTransport('send-and-receive-event', 2, 'alternate')).toBe('ws');
    expect(plannedTransport('check-notification', 1, 'alternate')).toBe('http');
    expect(plannedTransport('telegram-delivery', 3, 'ws')).toBe('ws');
    expect(plannedTransport('endpoints-probe', 1, 'alternate')).toBe('*');
  });

  it('lists what a configuration produces', () => {
    expect(producedTransports('send-and-receive-event', 'alternate')).toEqual(['http', 'ws']);
    expect(producedTransports('send-and-receive-event', 'http')).toEqual(['http']);
    expect(producedTransports('sourcemaps', 'alternate')).toEqual(['http']);
    expect(producedTransports('endpoints-probe', 'alternate')).toEqual(['*']);
  });

  it('keeps the transport in a pair only for the run and the variant stages', () => {
    expect(pairOf(failedAt('event_visible'), 'ws')).toBe('event_visible@ws');
    expect(pairOf(failedAt('telegram_probe'), 'ws')).toBe('telegram_probe@*');
    expect(pairOf(row({ status: 'aborted',
      errorClass: 'run_hung' }), 'ws')).toBe('run@ws');
    expect(VARIANT_STAGES).toEqual(['collector_accept', 'event_visible', 'event_repeated', 'threshold_formed']);
    expect(REPEAT_STAGES).toEqual(['event_repeated', 'threshold_formed']);
  });
});

/** Stages of each scenario in run order, with the repeat stages marked by the scenario that has them. */
const STAGES = new Map<ScenarioName, StageName[]>([
  ['send-and-receive-event', ['collector_availability', 'api_availability', 'collector_accept', 'event_visible', 'event_repeated', 'cleanup']],
  ['check-notification', ['collector_availability', 'api_availability', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'event_repeated', 'threshold_formed', 'cleanup']],
  ['telegram-delivery', ['collector_availability', 'api_availability', 'telegram_ready', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'telegram_delivered', 'telegram_probe', 'cleanup']],
  ['new-project', ['api_availability', 'project_created', 'token_accepted', 'event_visible', 'cleanup']],
  ['sourcemaps', ['collector_availability', 'api_availability', 'release_uploaded', 'release_saved', 'collector_accept', 'event_visible', 'cleanup']],
  ['sentry-envelope', ['collector_availability', 'api_availability', 'collector_accept', 'event_visible', 'cleanup']],
  ['endpoints-probe', ['collector_availability', 'api_availability', 'garage_availability', 'receiver_availability']],
]);
const REPEAT_EVERY = 6;

/**
 * Looks up the stages of a scenario.
 * @param scenario Scenario to look up.
 * @returns Its stages in run order.
 */
function stagesOf(scenario: ScenarioName): StageName[] {
  return STAGES.get(scenario) ?? [];
}
const SIMULATED_RUNS = 2 * REPEAT_EVERY + 2;

/**
 * Builds the `ok` run a scenario produces for a sequence number.
 * @param scenario Scenario that ran.
 * @param sequence Run number.
 * @param settings Settings with the transport mode and the repeats.
 * @returns The run and its transport.
 */
function simulated(scenario: ScenarioName, sequence: number, settings: AlertSettings): [RunRow, Where] {
  const transport = plannedTransport(scenario, sequence, settings.transportMode);
  const repeat = scenario !== 'telegram-delivery' && shouldRepeat(sequence, settings.transportMode, settings.repeatsOn ? REPEAT_EVERY : 0);
  const stages = stagesOf(scenario).map(name => stage(name, (REPEAT_STAGES.includes(name) && !repeat) || name === 'telegram_probe' ? 'skipped' : 'ok'));

  return [passed(stages, { scenario,
    sequence }), { transport }];
}

describe('decideAlert: every stage that can fail closes within a bounded number of runs', () => {
  const cases = [...STAGES].flatMap(([scenario, names]) => names.map(name => [scenario, name] as const));

  it.each(cases)('%s failing at %s', (scenario, at) => {
    for (const settings of [settingsOf(1), settingsOf(1, { repeatsOn: false }), settingsOf(1, { transportMode: 'http' })]) {
      for (let first = 1; first <= 2 * REPEAT_EVERY; first += 1) {
        const transport = plannedTransport(scenario, first, settings.transportMode);
        const before = stagesOf(scenario).slice(0, stagesOf(scenario).indexOf(at))
          .map(name => stage(name));
        const failure = failedAt(at, before, { scenario,
          sequence: first });
        const runs = Array.from({ length: SIMULATED_RUNS }, (_, index) => simulated(scenario, first + index + 1, settings));
        const { kinds } = play([[failure, { transport }], ...runs], settings, state({ scenario }));

        expect(kinds, `${scenario} ${at} from ${String(first)} ${JSON.stringify(settings)}`).toContain('recovered');
      }
    }
  });

  it.each([...STAGES.keys()])('%s: a stageless failure is closed by the next success of its transport', (scenario) => {
    for (const settings of [settingsOf(1), settingsOf(1, { repeatsOn: false })]) {
      for (let first = 1; first <= 2 * REPEAT_EVERY; first += 1) {
        const transport = plannedTransport(scenario, first, settings.transportMode);
        const hung = row({ scenario,
          sequence: first,
          status: 'aborted',
          errorClass: 'run_hung' });
        const runs = Array.from({ length: SIMULATED_RUNS }, (_, index) => simulated(scenario, first + index + 1, settings));
        const { kinds } = play([[hung, { transport }], ...runs], settings, state({ scenario }));

        expect(kinds, `${scenario} from ${String(first)}`).toContain('recovered');
      }
    }
  });

  it('a restart before every run does not change the outcome of 300 sequences', () => {
    let current = state();
    const recovered: number[] = [];

    for (let sequence = 1; sequence <= 300; sequence += 1) {
      const transport = chooseTransport(sequence, 'alternate');
      const bad = sequence % 7 === 0;
      const run = bad ? failedAt('event_visible', [], { sequence }) : simulated('send-and-receive-event', sequence, SETTINGS)[0];
      const decision = decideAlert(structuredClone(current), run, SETTINGS, NOW, { transport });

      if (decision.kind === 'recovered') {
        recovered.push(sequence);
      }

      current = decision.state;
    }

    expect(recovered.length).toBeGreaterThan(0);
  });
});

describe('decideAlert: episodes and causes', () => {
  const settings = settingsOf(3);

  it('opens the episode at the first failure of the series and reports its cause', () => {
    const first = failedAt('event_visible', [], { startedAt: '2026-03-10T11:50:00.000Z' });
    const { kinds, last } = play([[first, HTTP], [failedAt('event_visible'), HTTP], [failedAt('event_visible'), HTTP]], settings);

    expect(kinds).toEqual([undefined, undefined, 'failed']);
    expect(last).toMatchObject({ episodeStartedAt: '2026-03-10T11:50:00.000Z',
      reported: ['event_visible/event_not_found'] });
  });

  it('sends STILL FAILING once for each new cause of the episode', () => {
    const a = failedAt('event_visible');
    const b = failedAt('collector_accept', [], { errorClass: 'collector_unavailable' });
    const { kinds, last } = play([[a, HTTP], [b, HTTP], [a, HTTP], [b, HTTP], [b, HTTP]], SETTINGS);

    expect(kinds).toEqual(['failed', 'still_failing', undefined, undefined, undefined]);
    expect(last.reported).toEqual(['event_visible/event_not_found', 'collector_accept/collector_unavailable']);
  });

  it('a stageless cause is reported as run/<class>', () => {
    const hung = row({ status: 'aborted',
      errorClass: 'run_hung' });
    const { last } = play([[hung, HTTP]], SETTINGS);

    expect(last.reported).toEqual(['run/run_hung']);
  });

  it('the end of the episode clears the causes', () => {
    const { last } = play([[failedAt('event_visible'), HTTP], [passed([stage('event_visible')]), HTTP]], SETTINGS);

    expect(last.reported).toEqual([]);
  });
});

describe('shareEpisode: a message that was given up on', () => {
  const dropped = state({ state: 'failing',
    announced: false,
    open: [{ pair: 'event_visible@http',
      count: 1 }],
    reported: ['event_visible/event_not_found'],
    lastClass: 'event_not_found',
    lastStage: 'event_visible',
    episodeStartedAt: BEFORE });

  it('the next failure of the same cause sends FAILED again and the next success sends RECOVERED', () => {
    const again = failedAt('event_visible');
    const first = shareEpisode(dropped, decideAlert(dropped, again, SETTINGS, NOW, HTTP), again, []);

    expect(first.kind).toBe('failed');
    expect(first.state.announced).toBe(true);

    const ok = passed([stage('event_visible')]);

    expect(shareEpisode(first.state, decideAlert(first.state, ok, SETTINGS, NOW, HTTP), ok, []).kind).toBe('recovered');
  });

  it.each([
    ['skipped for overlap', row({ status: 'skipped',
      skipReason: 'overlap' })],
    ['skipped for the rule cache warmup', row({ status: 'skipped',
      skipReason: 'rule_cache_warmup' })],
    ['aborted by a stop of the monitor', row({ status: 'aborted',
      errorClass: 'monitor_stopped' })],
    ['aborted by a restart of the monitor', row({ status: 'aborted',
      errorClass: 'monitor_restarted' })],
  ])('a run that is %s leaves the held back state alone and says nothing', (_name, ignored) => {
    const result = shareEpisode(dropped, decideAlert(dropped, ignored, SETTINGS, NOW, HTTP), ignored, []);

    expect(result.kind).toBeUndefined();
    expect(result.state).toEqual(dropped);
    expect(result.state.announced).toBe(false);
  });

  it('a hung run of a held back scenario sends FAILED', () => {
    const hung = row({ status: 'aborted',
      errorClass: 'run_hung' });
    const result = shareEpisode(dropped, decideAlert(dropped, hung, SETTINGS, NOW, HTTP), hung, []);

    expect(result.kind).toBe('failed');
    expect(result.state.announced).toBe(true);
  });
});

describe('decideAlert: failures whose stage row says ok', () => {
  it('a failed run does not cover its own pair: threshold 2 fires on the second ws failure', () => {
    const verdictFailure = failedAt('event_visible', [], { errorClass: 'duplicate_event' });
    const asOk = { ...verdictFailure,
      stages: [stage('event_visible')] };
    const { kinds } = play([
      [asOk, WS],
      [passed([stage('event_visible')]), HTTP],
      [asOk, WS],
    ], settingsOf(2));

    expect(kinds).toEqual([undefined, undefined, 'failed']);
  });
});

describe('decideAlert: where an episode starts', () => {
  const probe = { scenario: 'endpoints-probe' } as const;
  const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

  it('a series of failures across availability stages starts at its first run and counts every failure', () => {
    const { kinds, last } = play([
      [failedAt('api_availability', [stage('collector_availability')], { ...probe,
        startedAt: at(1) }), { transport: '*' }],
      [failedAt('collector_availability', [stage('api_availability')], { ...probe,
        startedAt: at(2) }), { transport: '*' }],
      [failedAt('collector_availability', [stage('api_availability')], { ...probe,
        startedAt: at(3) }), { transport: '*' }],
    ], settingsOf(3), state({ scenario: 'endpoints-probe' }));

    expect(kinds).toEqual([undefined, undefined, 'failed']);
    expect(last).toMatchObject({ episodeStartedAt: at(1),
      episodeFailures: 3 });
  });

  it('an old pair does not move the start: the episode begins at the first failure of the series', () => {
    const old = state({ open: [{ pair: 'event_repeated@ws',
      count: 1,
      firstAt: at(-100) }] });
    const { kinds, last } = play([
      [failedAt('collector_availability', [], { startedAt: at(1) }), HTTP],
      [failedAt('collector_availability', [], { startedAt: at(2) }), HTTP],
    ], settingsOf(2), old);

    expect(kinds).toEqual([undefined, 'failed']);
    expect(last).toMatchObject({ episodeStartedAt: at(1),
      episodeFailures: 2 });
  });

  it('a pair that reaches the threshold across successes gives its own start and count', () => {
    const { kinds, last } = play([
      [failedAt('event_visible', [], { startedAt: at(1) }), WS],
      [passed([stage('event_visible')], { startedAt: at(2) }), HTTP],
      [failedAt('event_visible', [], { startedAt: at(3) }), WS],
    ], settingsOf(2));

    expect(kinds).toEqual([undefined, undefined, 'failed']);
    expect(last).toMatchObject({ episodeStartedAt: at(1),
      episodeFailures: 2 });
  });
});
