import type { CollectorClient } from '../../clients/collector.js';
import type { HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import type { CleanupResult, RunResult, StageResult } from '../../engine/result.js';
import { runStage, skippedStage } from '../../engine/stages.js';
import type { StageSpec } from '../../engine/stages.js';
import { createRedactor, redactDeep } from '../../errors/redact.js';
import type { Redactor } from '../../errors/redact.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Logger } from '../../log/logger.js';
import type { Clock } from '../../time/clock.js';
import { planRun, SCENARIO_NAME } from './plan.js';
import type { PlanOptions, RandomLetters } from './plan.js';
import { apiAvailabilityStage, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventRepeatedStage, eventVisibleStage } from './stages.js';
import type { ScenarioContext, ScenarioState } from './stages.js';
import { decideVerdict } from './verdict.js';

/** Everything `runSendAndReceive` needs from outside. */
export interface ScenarioDeps {
  /** Validated configuration. */
  config: Config;
  /** Collector client. */
  collector: CollectorClient;
  /** Hawk API client. */
  api: HawkApi;
  /** Time source. */
  clock: Clock;
  /** Logger of the run. */
  logger: Logger;
  /** Masks secrets in everything the result carries. */
  redact: Redactor;
  /** Source of letters for the run id, for tests. */
  randomLetters?: RandomLetters;
  /** Poll schedule override, for tests. */
  pollScheduleMs?: readonly number[];
}

/**
 * Builds the redactor for a run: password, integration token, its secret and the key the collector prints.
 * @param config Validated configuration.
 * @returns Redactor that masks all of them.
 */
export function createScenarioRedactor(config: Config): Redactor {
  const secrets = [config.hawk.password, config.hawk.integrationToken];
  const token = decodeIntegrationToken(config.hawk.integrationToken);

  if (token !== undefined) {
    secrets.push(token.secret, tokenKey(token));
  }

  return createRedactor(secrets);
}

/**
 * Maps the cleanup stage to the cleanup field of the result.
 * @param stage Recorded cleanup stage.
 * @returns Cleanup status; a refusal gets its own status, others carry class and text when failed.
 */
function toCleanupResult(stage: StageResult): CleanupResult {
  if (stage.status === 'ok' || stage.status === 'skipped') {
    return { status: stage.status };
  }

  const result: CleanupResult = { status: stage.errorClass === 'cleanup_refused' ? 'refused' : 'failed' };

  if (stage.errorClass !== undefined) {
    result.errorClass = stage.errorClass;
  }

  if (stage.message !== undefined) {
    result.message = stage.message;
  }

  return result;
}

/**
 * Runs the scenario once: stages 1-5 in order, then cleanup.
 * @param deps Configuration, clients, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runSendAndReceive(deps: ScenarioDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { budgets } = config;
  const plan = planRun(config, options, SCENARIO_NAME, deps.randomLetters);
  const state: ScenarioState = { sendMayHaveReached: false };
  const context: ScenarioContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs };
  const startedAt = clock.wallTime().toISOString();
  const t0 = clock.monotonicMs();
  const run = new AbortController();
  const timer = new AbortController();

  clock.sleep(budgets.run, timer.signal).then(() => {
    run.abort();
  }, () => undefined);

  const specs: Array<StageSpec<ScenarioContext>> = [
    collectorAvailabilityStage(budgets.collectorAvailability),
    apiAvailabilityStage(budgets.apiAvailability),
    collectorAcceptStage(budgets.collectorAccept),
    eventVisibleStage(budgets.eventVisible),
    eventRepeatedStage(budgets.eventRepeated),
  ];
  const stages: StageResult[] = [];
  let skipRest = false;

  for (const spec of specs) {
    if (skipRest) {
      stages.push(skippedStage(spec.name, clock));
    } else if (run.signal.aborted) {
      const error = new CheckError('run_timeout', { stage: spec.name }, { message: 'stage did not start before the run deadline' });

      stages.push({ name: spec.name,
        status: 'failed',
        startedAt: clock.wallTime().toISOString(),
        durationMs: 0,
        errorClass: error.errorClass,
        culprit: error.culprit,
        message: error.message });
      skipRest = true;
    } else {
      const result = await runStage(spec, context, { clock,
        runSignal: run.signal });

      stages.push(result);
      // A failed send that may have reached the collector still needs the search and the cleanup.
      skipRest = result.status === 'failed' && !(spec.name === 'collector_accept' && state.sendMayHaveReached);
    }
  }

  timer.abort();

  // Cleanup has its own budget outside the run deadline, so its signal is never aborted by the run.
  stages.push(await runStage(cleanupStage(budgets.cleanup), context, { clock,
    runSignal: new AbortController().signal }));

  const verdict = decideVerdict(stages, state);
  const cleanupStageResult = stages.at(-1);
  const result: RunResult = {
    runId: plan.runId,
    scenario: SCENARIO_NAME,
    instanceId: config.instanceId,
    sequence: plan.sequence,
    transport: plan.transport,
    catcherType: plan.catcherType,
    title: plan.title,
    startedAt,
    finishedAt: clock.wallTime().toISOString(),
    durationMs: clock.monotonicMs() - t0,
    status: verdict.status,
    warnings: stages.flatMap(stage => typeof stage.details?.warning === 'string' ? [stage.details.warning] : []),
    sendMayHaveReached: state.sendMayHaveReached,
    stages,
    cleanup: cleanupStageResult ? toCleanupResult(cleanupStageResult) : { status: 'skipped' },
  };

  if (verdict.failedStage) {
    result.failedStage = verdict.failedStage;
  }

  if (verdict.error) {
    result.errorClass = verdict.error.errorClass;
    result.culprit = verdict.error.culprit;
    result.message = verdict.error.message;
  }

  if (state.event) {
    result.event = { originalEventId: state.event.originalEventId,
      groupHash: state.event.groupHash,
      totalCount: state.event.totalCount };
  }

  if (state.latencyMs !== undefined) {
    result.eventLatencyMs = state.latencyMs;
  }

  const redacted = redactDeep(result, deps.redact);

  deps.logger.info('run finished', { runId: redacted.runId,
    status: redacted.status,
    failedStage: redacted.failedStage });

  return redacted;
}
