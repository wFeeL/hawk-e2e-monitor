import type { RunResult, StageName, StageResult } from '../../engine/result.js';
import { runStageGroup } from '../../engine/stages.js';
import type { StageSpec } from '../../engine/stages.js';
import { redactDeep } from '../../errors/redact.js';
import type { CheckError } from '../../errors/taxonomy.js';
import { ENDPOINTS_PROBE } from '../names.js';
import { createRunId } from '../shared/plan.js';
import { followOutsideSignal } from '../run-steps.js';
import type { ScenarioDeps } from '../shared/deps.js';
import { apiAvailabilityStage, collectorAvailabilityStage } from '../shared/availability.js';
import { errorOf } from '../shared/verdict.js';
import { garageAvailabilityStage } from './stages.js';
import type { ProbeContext } from './stages.js';

/** What identifies one probe. */
export interface ProbeOptions {
  /** Number of the run within its scenario. */
  sequence: number;
  /** Id of the run when the caller made it, such as the scheduler; made here otherwise. */
  runId?: string;
}

/**
 * Runs the probe once: the collector, the API and, with a Garage address, Garage answer.
 * The stages do not depend on each other, so they run side by side and a second failure shows too; the verdict names the first failed stage in the order of the stages.
 * No event is sent, so there is nothing to clean up.
 * @param deps Configuration, clients, clock, logger and redactor.
 * @param options Run number and id.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runEndpointsProbe(deps: ScenarioDeps, options: ProbeOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { timeouts } = config;
  const context: ProbeContext = { config,
    collector: deps.collector,
    api: deps.api,
    clock };
  const specs: Array<StageSpec<ProbeContext>> = [
    collectorAvailabilityStage(timeouts.collectorAvailability),
    apiAvailabilityStage(timeouts.apiAvailability),
    ...config.hawk.garageUrl === undefined ? [] : [garageAvailabilityStage(timeouts.garage)],
  ];
  const startedAt = clock.wallTime().toISOString();
  const t0 = clock.monotonicMs();
  const run = new AbortController();
  const timer = new AbortController();
  const unfollow = followOutsideSignal(run, deps.signal);

  // The stages run side by side, so the run lasts as long as the slowest of them could.
  clock.sleep(specs.reduce((sum, spec) => sum + spec.timeoutMs, 0), timer.signal).then(() => {
    run.abort();
  }, () => undefined);

  const stages: StageResult[] = await runStageGroup(specs, context, { clock,
    runSignal: run.signal });

  timer.abort();
  unfollow();

  const failed = stages.find(stage => stage.status === 'failed');
  const error: CheckError | undefined = failed === undefined ? undefined : errorOf(failed);
  const result: RunResult = {
    runId: options.runId ?? createRunId(),
    scenario: ENDPOINTS_PROBE,
    instanceId: config.instanceId,
    sequence: options.sequence,
    startedAt,
    finishedAt: clock.wallTime().toISOString(),
    durationMs: clock.monotonicMs() - t0,
    status: failed === undefined ? 'ok' : 'failed',
    warnings: stages.flatMap(stage => stage.details?.warning === undefined ? [] : [stage.details.warning]),
    sendMayHaveReached: false,
    stages,
    cleanup: { status: 'skipped' },
    ...failed === undefined ? {} : { failedStage: failed.name satisfies StageName },
    ...error === undefined
      ? {}
      : { errorClass: error.errorClass,
          culprit: error.culprit,
          message: error.message },
  };
  const redacted = redactDeep(result, deps.redact);

  deps.logger.info('run finished', { runId: redacted.runId,
    status: redacted.status,
    failedStage: redacted.failedStage });

  return redacted;
}
