import type { StageName, StageResult } from '../../engine/result.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { ScenarioState } from './stages.js';

/** Final outcome of a run. */
export interface Verdict {
  /** Whether the run passed. */
  status: 'ok' | 'failed';
  /** Stage the failure is blamed on. */
  failedStage?: StageName;
  /** Class, culprit and text of the failure. */
  error?: CheckError;
}

/**
 * Rebuilds the error of a recorded stage.
 * @param stage Stage result with a class and text.
 * @returns Error with the recorded class and text.
 */
function errorOf(stage: StageResult): CheckError {
  return new CheckError(stage.errorClass ?? 'monitor_internal', {}, { message: stage.message });
}

/**
 * Decides whether the run passed and which stage and error represent it.
 * A silent collector must not look like a loss inside Hawk, so an uncertain accept followed by a missing event is blamed on the collector.
 * @param stages Recorded stages, cleanup last.
 * @param _state Run state, unused: everything needed is in the stage results.
 * @returns Pass, or the stage and error that stand for the failure.
 */
export function decideVerdict(stages: readonly StageResult[], _state: ScenarioState): Verdict {
  const failed = stages.find(stage => stage.name !== 'cleanup' && stage.status === 'failed');

  if (failed === undefined) {
    const cleanup = stages.find(stage => stage.name === 'cleanup' && stage.status === 'failed');

    return cleanup === undefined
      ? { status: 'ok' }
      : { status: 'failed',
          failedStage: 'cleanup',
          error: errorOf(cleanup) };
  }

  const accept = stages.find(stage => stage.name === 'collector_accept');

  if (failed.name === 'event_visible' && accept?.status === 'uncertain') {
    if (failed.errorClass === 'event_not_found') {
      const waited = failed.details?.waitedMs;

      return { status: 'failed',
        failedStage: 'collector_accept',
        error: new CheckError(accept.errorClass ?? 'collector_unavailable', {},
          { message: `Collector did not confirm the event (${accept.message ?? 'no details'}); the event did not appear within ${typeof waited === 'number' ? String(waited) : 'the time limit'} ms` }) };
    }

    if (failed.details?.pollOutcome === 'api_error') {
      return { status: 'failed',
        failedStage: 'event_visible',
        error: new CheckError(failed.errorClass ?? 'monitor_internal', {},
          { message: `${failed.message ?? 'API error'}; the event was not confirmed by the collector either` }) };
    }
  }

  return { status: 'failed',
    failedStage: failed.name,
    error: errorOf(failed) };
}
