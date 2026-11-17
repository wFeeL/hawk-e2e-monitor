import type { AlertStateRow } from '../storage/types.js';
import { isMonitorAbort } from '../storage/outcome.js';
import type { DegradedCode, RunRow } from '../storage/types.js';

/** What a transition tells the operator. */
export type AlertKind = 'degraded' | 'failed' | 'recovered' | 'recovered_degraded' | 'still_failing';

/** The part of the configuration the decision needs. */
export interface AlertSettings {
  /** Failed runs in a row that raise the alert. */
  alertAfterFailures: number;
}

/** The new state and the message it calls for. */
export interface AlertDecision {
  /** State after the run. */
  state: AlertStateRow;
  /** Message to send; absent when nothing changed for the operator. */
  kind?: AlertKind;
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
 * Decides the alert state after a failed run.
 * @param previous State before the run.
 * @param row Failed run.
 * @param threshold Failed runs in a row that raise the alert.
 * @param now Current time, ISO.
 * @returns New state and message kind.
 */
function afterFailure(previous: AlertStateRow, row: RunRow, threshold: number, now: string): AlertDecision {
  const streak = previous.failureStreak + 1;
  const last = { ...row.errorClass === undefined ? {} : { lastClass: row.errorClass },
    ...row.failedStage === undefined ? {} : { lastStage: row.failedStage },
    lastRunId: row.runId };

  if (previous.state === 'failing') {
    const changed = row.errorClass !== previous.lastClass || row.failedStage !== previous.lastStage;
    const { lastClass: _class, lastStage: _stage, ...kept } = previous;

    return { state: { ...kept,
      ...last,
      failureStreak: streak,
      episodeFailures: previous.episodeFailures + 1,
      updatedAt: now },
    ...changed ? { kind: 'still_failing' } : {} };
  }

  if (streak < threshold) {
    return { state: { ...previous,
      failureStreak: streak,
      updatedAt: now } };
  }

  return { state: { scenario: previous.scenario,
    state: 'failing',
    failureStreak: streak,
    ...last,
    episodeStartedAt: row.startedAt,
    episodeFailures: streak,
    degraded: [],
    updatedAt: now },
  kind: 'failed' };
}

/**
 * Decides the alert state after an `ok` run.
 * @param previous State before the run.
 * @param row Run that ended `ok`.
 * @param now Current time, ISO.
 * @returns New state and message kind.
 */
function afterSuccess(previous: AlertStateRow, row: RunRow, now: string): AlertDecision {
  const degraded = row.degraded.length > 0;
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
 * @param previous State before the run, absent for a scenario never seen.
 * @param row Finished run, not `running`.
 * @param settings Failed runs in a row that raise the alert.
 * @param now Current time, ISO.
 * @returns New state and the message to send, if any.
 */
export function decideAlert(previous: AlertStateRow | undefined, row: RunRow, settings: AlertSettings, now: string): AlertDecision {
  const before: AlertStateRow = previous ?? { scenario: row.scenario,
    state: 'ok',
    failureStreak: 0,
    episodeFailures: 0,
    degraded: [],
    updatedAt: now };

  if (isIgnored(row)) {
    return { state: before };
  }

  if (row.status === 'ok') {
    return afterSuccess(before, row, now);
  }

  return afterFailure(before, row, settings.alertAfterFailures, now);
}
