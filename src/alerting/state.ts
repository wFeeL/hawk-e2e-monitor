import type { Transport } from '../clients/collector.js';
import type { TransportMode } from '../config/schema.js';
import type { DegradedCode, StageName } from '../engine/result.js';
import { ENDPOINTS_PROBE, NEW_PROJECT, SENTRY_ENVELOPE, SOURCEMAPS } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import { chooseTransport } from '../scenarios/shared/plan.js';
import { isMonitorAbort } from '../storage/outcome.js';
import type { AlertStateRow, OpenPair, RunRow } from '../storage/types.js';

/** Stages whose outcome depends on the transport of the run: the event takes a different path in the collector. */
export const VARIANT_STAGES: readonly StageName[] = ['collector_accept', 'event_visible', 'event_repeated', 'threshold_formed'];

/** Stages that only a run with a repeat executes. */
export const REPEAT_STAGES: readonly StageName[] = ['event_repeated', 'threshold_formed'];

/** Scenarios that send their event over HTTP whatever the configuration says. */
export const FORCED_HTTP: readonly ScenarioName[] = [SOURCEMAPS, SENTRY_ENVELOPE, NEW_PROJECT];

/** Stages whose failure says that Hawk itself is down, whichever scenario noticed it. */
export const AVAILABILITY_STAGES: readonly StageName[] = ['collector_availability', 'api_availability'];

/** A transport, or `*` for a failure that does not depend on one. */
export type PairTransport = Transport | '*';

/** What a transition tells the operator. */
export type AlertKind = 'degraded' | 'failed' | 'recovered' | 'recovered_degraded' | 'still_failing';

/** The part of the configuration the decision needs. */
export interface AlertSettings {
  /** Failed runs in a row that raise the alert. */
  alertAfterFailures: number;
  /** True while runs repeat the event, which is when a repeat stage can run. */
  repeatsOn: boolean;
  /** Transport mode of the configuration. */
  transportMode: TransportMode;
}

/** What the decision needs to know about the run besides its row. */
export interface RunInfo {
  /** Transport of the run; `*` for a scenario that sends no event. */
  transport: PairTransport;
}

/** The new state and the message it calls for. */
export interface AlertDecision {
  /** State after the run. */
  state: AlertStateRow;
  /** Message to send; absent when nothing changed for the operator. */
  kind?: AlertKind;
}

/**
 * Finds the transport a run of a scenario uses when its result is not known.
 * @param scenario Scenario of the run.
 * @param sequence Run number.
 * @param mode Transport mode of the configuration.
 * @returns HTTP for a forced scenario, the alternation otherwise, `*` for the probe.
 */
export function plannedTransport(scenario: ScenarioName, sequence: number, mode: TransportMode): PairTransport {
  if (scenario === ENDPOINTS_PROBE) {
    return '*';
  }

  return FORCED_HTTP.includes(scenario) ? 'http' : chooseTransport(sequence, mode);
}

/**
 * Lists the transports the configuration makes a scenario use.
 * @param scenario Scenario whose runs are listed.
 * @param mode Transport mode of the configuration.
 * @returns `*` for the probe, HTTP for a forced scenario, both or the fixed one otherwise.
 */
export function producedTransports(scenario: ScenarioName, mode: TransportMode): readonly PairTransport[] {
  if (scenario === ENDPOINTS_PROBE) {
    return ['*'];
  }

  if (FORCED_HTTP.includes(scenario)) {
    return ['http'];
  }

  return mode === 'alternate' ? ['http', 'ws'] : [mode];
}

/**
 * Names the failure of a run as the pair that a later run has to cover.
 * @param row Failed run.
 * @param transport Transport of the run.
 * @returns `<stage>@<transport>`; the transport is kept for a stageless failure and a variant stage, `*` otherwise.
 */
export function pairOf(row: RunRow, transport: PairTransport): string {
  const stage = row.failedStage ?? 'run';

  return `${stage}@${stage === 'run' || VARIANT_STAGES.includes(stage) ? transport : '*'}`;
}

/**
 * Tells whether a finished run covers a failure that is still open.
 * A failed run covers only what it passed; success also covers what it skipped by design.
 * @param pair Open pair, `<stage>@<transport>`.
 * @param row Finished run.
 * @param transport Transport of the run.
 * @param settings Configuration the decision runs under.
 * @returns True when the failure is no longer there.
 */
export function covers(pair: string, row: RunRow, transport: PairTransport, settings: AlertSettings): boolean {
  const split = pair.lastIndexOf('@');
  const stage = pair.slice(0, split);
  const pairTransport = pair.slice(split + 1);
  const success = row.status === 'ok';

  if (success && pairTransport !== '*' && !(producedTransports(row.scenario, settings.transportMode) as readonly string[]).includes(pairTransport)) {
    return true;
  }

  if (stage === 'run') {
    return success && pairTransport === transport;
  }

  // A verdict can fail a run on a stage whose own row ended `ok`; the failure is still there.
  if (!success && stage === row.failedStage) {
    return false;
  }

  const result = row.stages.find(item => item.name === stage)?.status;
  const variant = VARIANT_STAGES.includes(stage as StageName);

  if (result === 'ok') {
    return !variant || pairTransport === transport;
  }

  if (!success || (result !== undefined && result !== 'skipped')) {
    return false;
  }

  return REPEAT_STAGES.includes(stage as StageName) ? !settings.repeatsOn : !variant;
}

/**
 * Tells whether a run leaves the alert state untouched.
 * @param row Finished run.
 * @returns True for skipped runs and aborts by a stop or restart of the monitor.
 */
function isIgnored(row: RunRow): boolean {
  return row.status === 'skipped'
    || isMonitorAbort(row);
}

/**
 * Tells whether two lists hold the same codes.
 * @param left First list.
 * @param right Second list.
 * @returns True when the sets are equal, order aside.
 */
function sameCodes(left: readonly DegradedCode[], right: readonly DegradedCode[]): boolean {
  return left.length === right.length && left.every(code => right.includes(code));
}

/**
 * Adds a failure to the open pairs.
 * @param open Pairs still open.
 * @param pair Pair of the new failure.
 * @param startedAt Start of the failed run, kept as the first sighting of a new pair.
 * @returns The list with the pair added or its count raised.
 */
function withPair(open: readonly OpenPair[], pair: string, startedAt: string): OpenPair[] {
  if (!open.some(item => item.pair === pair)) {
    return [...open, { pair,
      count: 1,
      firstAt: startedAt }];
  }

  return open.map(item => item.pair === pair
    ? { ...item,
        count: item.count + 1 }
    : item);
}

/**
 * Decides the alert state after a failed run.
 * @param previous State before the run, with the pairs the run covered already taken out.
 * @param row Failed run.
 * @param threshold Failed runs in a row that raise the alert.
 * @param now Current time, ISO.
 * @param pair Pair the failed run adds, `<stage>@<transport>`.
 * @returns New state and message kind.
 */
function afterFailure(previous: AlertStateRow, row: RunRow, threshold: number, now: string, pair: string): AlertDecision {
  const streak = previous.failureStreak + 1;
  const open = withPair(previous.open, pair, row.startedAt);
  const own = open.find(item => item.pair === pair);
  const count = own?.count ?? 1;
  const streakStartedAt = previous.failureStreak === 0 ? row.startedAt : previous.streakStartedAt ?? row.startedAt;
  const last = { ...row.errorClass === undefined ? {} : { lastClass: row.errorClass },
    ...row.failedStage === undefined ? {} : { lastStage: row.failedStage },
    lastRunId: row.runId };

  const cause = `${row.failedStage ?? 'run'}/${row.errorClass ?? '-'}`;

  if (previous.state === 'failing') {
    const changed = (row.errorClass !== previous.lastClass || row.failedStage !== previous.lastStage) && !previous.reported.includes(cause);
    const { lastClass: _class, lastStage: _stage, ...kept } = previous;

    return { state: { ...kept,
      ...last,
      failureStreak: streak,
      episodeFailures: previous.episodeFailures + 1,
      open,
      streakStartedAt,
      reported: previous.reported.includes(cause) ? previous.reported : [...previous.reported, cause],
      updatedAt: now },
    ...changed ? { kind: 'still_failing' } : {} };
  }

  if (streak < threshold && count < threshold) {
    return { state: { ...previous,
      failureStreak: streak,
      open,
      streakStartedAt,
      updatedAt: now } };
  }

  // The series that reached the threshold counts as a whole; otherwise the pair that did tells where the episode began.
  const bySeries = streak >= threshold;

  return { state: { scenario: previous.scenario,
    state: 'failing',
    failureStreak: streak,
    ...last,
    episodeStartedAt: bySeries ? streakStartedAt : own?.firstAt ?? row.startedAt,
    episodeFailures: bySeries ? streak : count,
    degraded: [],
    open,
    announced: true,
    streakStartedAt,
    reported: [cause],
    updatedAt: now },
  kind: 'failed' };
}

/**
 * Decides the alert state after an `ok` run.
 * @param previous State before the run, with the pairs the run covered already taken out.
 * @param row Run that ended `ok`.
 * @param now Current time, ISO.
 * @returns New state and message kind.
 */
function afterSuccess(previous: AlertStateRow, row: RunRow, now: string): AlertDecision {
  const degraded = row.degraded.length > 0;
  const stillOpen = previous.open.length > 0;

  if (previous.state === 'failing' && stillOpen) {
    return { state: { ...previous,
      failureStreak: 0,
      updatedAt: now } };
  }

  // The episode stays on the state only for the message of the recovery.
  const episode = previous.state === 'failing'
    ? { ...previous.episodeStartedAt === undefined ? {} : { episodeStartedAt: previous.episodeStartedAt },
        episodeFailures: previous.episodeFailures }
    : { episodeFailures: 0 };
  const next = (state: AlertStateRow['state']): AlertStateRow => ({ scenario: previous.scenario,
    state,
    failureStreak: 0,
    ...previous.lastClass === undefined ? {} : { lastClass: previous.lastClass },
    ...previous.lastStage === undefined ? {} : { lastStage: previous.lastStage },
    ...previous.lastRunId === undefined ? {} : { lastRunId: previous.lastRunId },
    ...episode,
    degraded: row.degraded,
    open: previous.state === 'failing' ? [] : previous.open,
    announced: true,
    reported: [],
    updatedAt: now });

  switch (previous.state) {
    case 'failing':
      return degraded
        ? { state: next('degraded'),
            kind: 'recovered_degraded' }
        : { state: next('ok'),
            kind: 'recovered' };
    case 'degraded':
      if (!degraded) {
        return { state: next('ok'),
          kind: 'recovered' };
      }

      return sameCodes(previous.degraded, row.degraded)
        ? { state: next('degraded') }
        : { state: next('degraded'),
            kind: 'degraded' };
    case 'ok':
      return degraded
        ? { state: next('degraded'),
            kind: 'degraded' }
        : { state: next('ok') };
  }
}

/**
 * Applies a finished run to the alert state of its scenario.
 * The run first takes out the failures it covers, a failed run included, then a failed run adds its own.
 * @param previous State before the run, absent for a scenario never seen.
 * @param row Finished run, not `running`.
 * @param settings Threshold, repeats and transport mode.
 * @param now Current time, ISO.
 * @param run Transport of the run.
 * @returns New state and the message to send, if any.
 */
export function decideAlert(previous: AlertStateRow | undefined, row: RunRow, settings: AlertSettings, now: string, run: RunInfo): AlertDecision {
  const before: AlertStateRow = previous ?? { scenario: row.scenario,
    state: 'ok',
    failureStreak: 0,
    episodeFailures: 0,
    degraded: [],
    open: [],
    announced: true,
    reported: [],
    updatedAt: now };

  if (isIgnored(row)) {
    return { state: before };
  }

  const remaining = before.open.filter(item => !covers(item.pair, row, run.transport, settings));
  const open = { ...before,
    open: remaining };

  if (row.status === 'ok') {
    return afterSuccess(open, row, now);
  }

  return afterFailure(open, row, settings.alertAfterFailures, now, pairOf(row, run.transport));
}

/**
 * Holds back the message of a scenario whose outage another scenario already announced.
 * @param previous State before the run, absent for a scenario never seen.
 * @param decision What `decideAlert` decided.
 * @param row Finished run.
 * @param leaders States of the other scenarios that may lead: frequent, failing, announced and fresh.
 * @returns The decision with the message dropped or added, and `announced` set to match.
 */
export function shareEpisode(previous: AlertStateRow | undefined, decision: AlertDecision, row: RunRow, leaders: readonly AlertStateRow[]): AlertDecision {
  const stage = row.status === 'ok' ? undefined : row.failedStage;
  const availability = stage !== undefined && AVAILABILITY_STAGES.includes(stage);
  const led = availability && leaders.some(leader => leader.open.some(item => item.pair.startsWith(`${stage}@`)));
  const { state, kind } = decision;

  if (kind === 'failed' && led) {
    return { state: { ...state,
      announced: false } };
  }

  if (previous?.state !== 'failing' || previous.announced) {
    return decision;
  }

  if (kind === 'recovered') {
    return { state };
  }

  if (kind === 'recovered_degraded') {
    return { state,
      kind: 'degraded' };
  }

  if (row.status === 'ok') {
    return decision;
  }

  if (led) {
    return { state: { ...state,
      announced: false } };
  }

  return { state: { ...state,
    announced: true },
  kind: 'failed' };
}
