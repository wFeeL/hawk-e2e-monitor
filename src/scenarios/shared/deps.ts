import type { CollectorClient } from '../../clients/collector.js';
import type { HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import { createRedactor } from '../../errors/redact.js';
import type { Redactor } from '../../errors/redact.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Logger } from '../../log/logger.js';
import type { Clock } from '../../time/clock.js';
import type { RandomLetters } from './plan.js';

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
