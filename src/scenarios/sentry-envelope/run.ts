import { scenarioSettings } from '../../config/scenario.js';
import type { RunResult } from '../../engine/result.js';
import { SENTRY_ENVELOPE } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import { planRun } from '../shared/plan.js';
import type { PlanOptions } from '../shared/plan.js';
import type { ScenarioDeps } from '../shared/deps.js';
import { apiAvailabilityStage, collectorAvailabilityStage } from '../shared/availability.js';
import { cleanupStage } from '../shared/cleanup.js';
import { eventVisibleStage } from '../shared/delivery.js';
import type { ScenarioContext, ScenarioState } from '../shared/context.js';
import { decideVerdict } from '../shared/verdict.js';
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
