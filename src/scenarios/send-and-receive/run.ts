import type { CollectorClient } from '../../clients/collector.js';
import type { HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import type { RunResult } from '../../engine/result.js';
import { createRedactor } from '../../errors/redact.js';
import type { Redactor } from '../../errors/redact.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Logger } from '../../log/logger.js';
import type { Clock } from '../../time/clock.js';
import { SEND_AND_RECEIVE_EVENT } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import { planRun } from './plan.js';
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
  /** Cancels the run from outside like its own deadline does; cleanup still runs with its own timeout. */
  signal?: AbortSignal;
}

/**
 * Lists the values that must never reach the output: password, integration token, its secret, the key the collector prints and the receiver secret.
 * @param config Validated configuration.
 * @returns Every such value that is known at the start; the receiver secret may be empty.
 */
export function scenarioSecrets(config: Config): string[] {
  const secrets = [config.hawk.password, config.hawk.integrationToken, config.notifications.receiverSecret ?? ''];
  const token = decodeIntegrationToken(config.hawk.integrationToken);

  if (token !== undefined) {
    secrets.push(token.secret, tokenKey(token));
  }

  const { botToken, notifyUrl } = config.scenarios.telegramDelivery;

  if (botToken !== undefined) {
    secrets.push(botToken);
  }

  if (notifyUrl !== undefined) {
    // The path token is masked on its own: Hawk and codex.bot may print it without the rest of the address.
    secrets.push(notifyUrl, ...URL.canParse(notifyUrl) ? [new URL(notifyUrl).pathname.split('/').at(-1) ?? ''] : []);
  }

  return secrets;
}

/**
 * Builds the redactor for a run from `scenarioSecrets`.
 * @param config Validated configuration.
 * @returns Redactor that masks all of them.
 */
export function createScenarioRedactor(config: Config): Redactor {
  return createRedactor(scenarioSecrets(config));
}

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
