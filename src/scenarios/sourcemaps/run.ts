import { scenarioSettings } from '../../config/scenario.js';
import type { RunResult } from '../../engine/result.js';
import { SOURCEMAPS } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import { planRun } from '../shared/plan.js';
import type { PlanOptions } from '../shared/plan.js';
import type { ScenarioDeps } from '../shared/deps.js';
import { apiAvailabilityStage, collectorAvailabilityStage } from '../shared/availability.js';
import { cleanupStage } from '../shared/cleanup.js';
import { collectorAcceptStage, eventVisibleStage } from '../shared/delivery.js';
import type { ScenarioState } from '../shared/context.js';
import { decideVerdict } from '../shared/verdict.js';
import { buildSourceMap } from './map.js';
import { releaseSavedStage, releaseUploadedStage, sourcemapsShape } from './stages.js';
import type { SourcemapsContext } from './stages.js';

const JAVASCRIPT_CATCHER = 'errors/javascript';

/**
 * Runs the scenario once: uploads a release with a map, waits until Hawk shows it, sends a JavaScript event of that release and checks that the frame came back mapped.
 * Each run has a release of its own, so the cache of the JavaScript worker never holds an old answer; the releases stay in Hawk until the archiver takes them.
 * @param deps Configuration, clients, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runSourcemaps(deps: ScenarioDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { timeouts } = config;
  const plan = planRun(config, { ...options,
    transport: 'http',
    repeat: false,
    catcherType: JAVASCRIPT_CATCHER }, SOURCEMAPS, deps.randomLetters);
  const state: ScenarioState = { sendMayHaveReached: false };
  const context: SourcemapsContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs,
    built: buildSourceMap(plan.runId),
    release: `e2e-${config.instanceId}-${plan.runId}` };
  const settings = scenarioSettings(config, SOURCEMAPS);

  context.eventShape = sourcemapsShape(context);

  const outcome = await runSteps({ context,
    clock,
    runTimeoutMs: settings.watchdogMs - settings.cleanupMs - config.monitoring.watchdogGraceMs,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    steps: [
      [collectorAvailabilityStage(timeouts.collectorAvailability)],
      [apiAvailabilityStage(timeouts.apiAvailability, { title: plan.title })],
      [releaseUploadedStage(timeouts.collectorAccept)],
      [releaseSavedStage(config.scenarios.sourcemaps.releaseSaveTimeoutMs)],
      [collectorAcceptStage(timeouts.collectorAccept)],
      [eventVisibleStage(timeouts.eventVisible)],
    ],
    // A failed send that may have reached the collector still needs the search and the cleanup.
    keepGoing: failed => failed.name === 'collector_accept' && state.sendMayHaveReached,
    cleanup: cleanupStage(timeouts.cleanup) });

  return buildRunResult({ scenario: SOURCEMAPS,
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
