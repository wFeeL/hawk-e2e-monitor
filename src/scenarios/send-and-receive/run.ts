import type { RunResult } from '../../engine/result.js';
import { SEND_AND_RECEIVE_EVENT } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import type { ScenarioDeps } from '../shared/deps.js';
import { planRun } from '../shared/plan.js';
import type { PlanOptions } from '../shared/plan.js';
import { apiAvailabilityStage, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventRepeatedStage, eventVisibleStage } from './stages.js';
import type { ScenarioContext, ScenarioState } from './stages.js';
import { decideVerdict } from '../shared/verdict.js';

/**
 * Runs the scenario once: stages 1-5 in order, then cleanup.
 * @param deps Configuration, clients, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runSendAndReceive(deps: ScenarioDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { timeouts } = config;
  const plan = planRun(config, options, SEND_AND_RECEIVE_EVENT, deps.randomLetters);
  const state: ScenarioState = { sendMayHaveReached: false };
  const context: ScenarioContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs };
  const outcome = await runSteps({ context,
    clock,
    runTimeoutMs: timeouts.run,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    steps: [
      [collectorAvailabilityStage(timeouts.collectorAvailability)],
      [apiAvailabilityStage(timeouts.apiAvailability, { title: plan.title })],
      [collectorAcceptStage(timeouts.collectorAccept)],
      [eventVisibleStage(timeouts.eventVisible)],
      [eventRepeatedStage(timeouts.eventRepeated)],
    ],
    // A failed send that may have reached the collector still needs the search and the cleanup.
    keepGoing: failed => failed.name === 'collector_accept' && state.sendMayHaveReached,
    cleanup: cleanupStage(timeouts.cleanup) });

  return buildRunResult({ scenario: SEND_AND_RECEIVE_EVENT,
    plan,
    instanceId: config.instanceId,
    outcome,
    clock,
    verdict: decideVerdict(outcome.stages, state),
    warnings: stageWarnings(outcome.stages),
    state,
    redact: deps.redact,
    logger: deps.logger });
}
