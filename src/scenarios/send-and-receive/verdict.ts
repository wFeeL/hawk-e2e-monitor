import { formatDuration } from '../../time/format.js';
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
export function errorOf(stage: StageResult): CheckError {
  return new CheckError(stage.errorClass ?? 'monitor_internal', {}, { message: stage.message,
    ...stage.culprit === undefined ? {} : { culprit: stage.culprit } });
}

/**
 * Finds the failure of the first failed stage, with the corrections for a silent collector or release upload.
 * A silent collector must not look like a loss inside Hawk, so an uncertain accept followed by a missing event is blamed on the collector,
 * and so is an uncertain release upload followed by a release that is not saved.
 * @param stages Recorded stages; cleanup is not looked at.
 * @returns The verdict that stands for the failure, or undefined when no stage failed.
 */
export function decideHead(stages: readonly StageResult[]): Verdict | undefined {
  const failed = stages.find(stage => stage.name !== 'cleanup' && stage.status === 'failed');

  if (failed === undefined) {
    return undefined;
  }

  const accept = stages.find(stage => stage.name === 'collector_accept');

  if (failed.name === 'event_visible' && accept?.status === 'uncertain') {
    if (failed.errorClass === 'event_not_found') {
      const waited = failed.details?.waitedMs;

      return { status: 'failed',
        failedStage: 'collector_accept',
        error: new CheckError(accept.errorClass ?? 'collector_unavailable', {},
          { message: `Collector did not confirm the event (${accept.message ?? 'no details'}); the event did not appear within ${typeof waited === 'number' ? formatDuration(waited) : 'the time limit'}` }) };
    }

    if (failed.details?.pollOutcome === 'api_error') {
      return { status: 'failed',
        failedStage: 'event_visible',
        error: new CheckError(failed.errorClass ?? 'monitor_internal', {},
          { message: `${failed.message ?? 'API error'}; the event was not confirmed by the collector either` }) };
    }
  }

  const upload = stages.find(stage => stage.name === 'release_uploaded');

  // A release that never showed after an unconfirmed upload was most likely lost by the collector.
  if (failed.name === 'release_saved' && failed.errorClass === 'release_not_saved' && upload?.status === 'uncertain') {
    return { status: 'failed',
      failedStage: 'release_uploaded',
      error: errorOf(upload) };
  }

  return { status: 'failed',
    failedStage: failed.name,
    error: errorOf(failed) };
}

/**
 * Judges what only a run without a failed stage can fail on: the event counted again after the check, and the cleanup.
 * @param stages Recorded stages with the cleanup stage.
 * @returns Pass, or the failure of the late count or of the cleanup.
 */
export function decideTail(stages: readonly StageResult[]): Verdict {
  const late = stages.find(stage => stage.name === 'cleanup')?.details?.lateTotalCount;

  if (typeof late === 'number') {
    const repeated = stages.find(stage => stage.name === 'event_repeated')?.status === 'ok';

    return { status: 'failed',
      failedStage: repeated ? 'event_repeated' : 'event_visible',
      error: new CheckError('duplicate_event', { count: late },
        { message: `The event count grew to ${String(late)} after the check, expected ${repeated ? '2' : '1'}` }) };
  }

  const cleanup = stages.find(stage => stage.name === 'cleanup' && stage.status === 'failed');

  return cleanup === undefined
    ? { status: 'ok' }
    : { status: 'failed',
        failedStage: 'cleanup',
        error: errorOf(cleanup) };
}

/**
 * Decides whether the run passed and which stage and error represent it.
 * @param stages Recorded stages, cleanup last.
 * @param _state Run state, unused: everything needed is in the stage results.
 * @returns Pass, or the stage and error that stand for the failure.
 */
export function decideVerdict(stages: readonly StageResult[], _state: ScenarioState): Verdict {
  return decideHead(stages) ?? decideTail(stages);
}
