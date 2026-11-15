import { scenarioSettings } from '../../config/scenario.js';
import type { RunResult } from '../../engine/result.js';
import { SENTRY_ENVELOPE } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import { planRun } from '../send-and-receive/plan.js';
import type { PlanOptions } from '../send-and-receive/plan.js';
import type { ScenarioDeps } from '../send-and-receive/run.js';
import { apiAvailabilityStage, cleanupStage, collectorAvailabilityStage, eventVisibleStage } from '../send-and-receive/stages.js';
import type { ScenarioContext, ScenarioState } from '../send-and-receive/stages.js';
import { decideVerdict } from '../send-and-receive/verdict.js';
import { DEFAULT_CATCHER, envelopeAcceptStage, sentryShape, sentryTitle } from './stages.js';

/**
 * Runs the scenario once: posts a Sentry envelope, finds the event the collector made of it and removes it.
 * @param deps Configuration, clients, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runSentryEnvelope(deps: ScenarioDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { timeouts } = config;
  const plan = planRun(config, { ...options,
    transport: 'http',
    repeat: false,
    catcherType: DEFAULT_CATCHER }, SENTRY_ENVELOPE, deps.randomLetters);
  const state: ScenarioState = { sendMayHaveReached: false };
  const context: ScenarioContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs };
  const settings = scenarioSettings(config, SENTRY_ENVELOPE);

  context.eventShape = sentryShape(context);

  const outcome = await runSteps({ context,
    clock,
    runTimeoutMs: settings.watchdogMs - settings.cleanupMs - config.monitoring.watchdogGraceMs,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    steps: [
      [collectorAvailabilityStage(timeouts.collectorAvailability)],
      [apiAvailabilityStage(timeouts.apiAvailability, { title: sentryTitle(plan) })],
      [envelopeAcceptStage(timeouts.collectorAccept)],
      [eventVisibleStage(timeouts.eventVisible)],
    ],
    // A failed send that may have reached the collector still needs the search and the cleanup.
    keepGoing: failed => failed.name === 'collector_accept' && state.sendMayHaveReached,
    cleanup: cleanupStage(timeouts.cleanup) });

  return buildRunResult({ scenario: SENTRY_ENVELOPE,
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
