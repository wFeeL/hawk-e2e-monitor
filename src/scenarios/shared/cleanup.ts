import type { FoundEvent } from '../../clients/hawk-api.js';
import type { StageDetails } from '../../engine/result.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { ScenarioContext } from './context.js';
import { shapeOf } from './event.js';

/**
 * Wraps a failure of a cleanup call into `cleanup_failed`.
 * @param error What the call threw.
 * @returns Error of class `cleanup_failed`, or the input when it is not a check error.
 */
function cleanupFailure(error: unknown): unknown {
  return error instanceof CheckError
    ? new CheckError('cleanup_failed', { detail: error.message }, { cause: error })
    : error;
}

/**
 * Stage 6: removes the test event when it is ours.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function cleanupStage(timeoutMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'cleanup',
    timeoutMs,
    run: async (context, signal, earlier): Promise<StageOutcome> => {
      const { api, clock, config, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;
      const refuse = (event: FoundEvent): CheckError => new CheckError('cleanup_refused', { detail: `"${event.title}" (${event.originalEventId})` });
      const details: StageDetails = {};
      let target = state.event;

      if (target === undefined) {
        // An accepted event may still be on its way through the workers, so look for it too.
        if (!state.sendMayHaveReached && state.sendOutcome?.kind !== 'accepted') {
          return { status: 'skipped' };
        }

        let found: FoundEvent[];

        try {
          found = await api.findEvents(projectId, plan.runId, signal);
        } catch (error) {
          throw cleanupFailure(error);
        }

        const [first] = found;

        if (first === undefined) {
          return { status: 'skipped',
            details: { found: false } };
        }

        target = found.find(event => shape.isOurs(event));

        if (target === undefined) {
          throw refuse(first);
        }

        // The event outran stage 4's deadline; leave a trace so the late arrival is visible in the result.
        details.foundBySearch = true;
        details.originalEventId = target.originalEventId;
      } else {
        if (!shape.isOurs(target)) {
          throw refuse(target);
        }

        // A worker may count one more copy after the check, so wait a little before the recheck.
        // The verdict reads the count from `details`.
        let cut = false;

        // The pause waits for a late copy that would change the verdict of a passed run; a failed run has its verdict already.
        const failedSoFar = earlier?.some(stage => stage.status === 'failed') === true;

        if (config.lateDuplicateWaitMs > 0 && !failedSoFar) {
          try {
            await clock.sleep(config.lateDuplicateWaitMs, signal);
          } catch {
            cut = true;
          }
        }

        if (cut) {
          // The stage signal is already aborted here, so a removal would fail at once and blame Hawk.
          return { status: 'failed',
            error: new CheckError('monitor_internal', { detail: 'the cleanup time limit ran out during the wait for a late copy; the sweep removes the event' }),
            details: { recheck: 'skipped' } };
        } else {
          // The read gets one HTTP timeout of its own, so retries inside the transport cannot eat the time the removal needs.
          const recheck = new AbortController();
          const timer = new AbortController();
          const onStageAbort = (): void => {
            recheck.abort();
          };

          if (signal.aborted) {
            onStageAbort();
          } else {
            signal.addEventListener('abort', onStageAbort, { once: true });
          }

          clock.sleep(config.httpTimeoutMs, timer.signal).then(onStageAbort, () => undefined);

          try {
            const card = await api.eventCard(projectId, target.originalEventId, recheck.signal);

            if (card === null) {
              details.recheck = 'missing';
            } else if (card.totalCount > target.totalCount) {
              details.lateTotalCount = card.totalCount;
            }
          } catch (error) {
            if (!(error instanceof CheckError)) {
              throw error;
            }

            details.recheck = 'failed';
            details.warning = `The event count could not be rechecked before cleanup: ${error.message}`;
          } finally {
            timer.abort();
            signal.removeEventListener('abort', onStageAbort);
          }
        }
      }

      if (details.recheck === 'missing') {
        // Nothing is left to remove, and the run passed on what it saw before the event went.
        details.warning = 'event was already gone before cleanup';

        return { status: 'ok',
          details };
      }

      const withDetails = (outcome: StageOutcome): StageOutcome => Object.keys(details).length > 0
        ? { ...outcome,
            details }
        : outcome;
      let removed: boolean;

      try {
        removed = await api.removeEvent(projectId, target.originalEventId, signal);
      } catch (error) {
        const failure = cleanupFailure(error);

        if (!(failure instanceof CheckError)) {
          throw failure;
        }

        return withDetails({ status: 'failed',
          error: failure });
      }

      if (!removed) {
        return withDetails({ status: 'failed',
          error: new CheckError('cleanup_failed', { detail: 'Hawk answered that nothing was removed' }) });
      }

      if (details.foundBySearch === true) {
        details.warning = 'The event appeared only after the event_visible deadline and was removed by cleanup';
      }

      return withDetails({ status: 'ok' });
    },
  };
}
