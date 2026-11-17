import type { Config } from '../config/load.js';
import { createMutableRedactor } from '../errors/redact.js';
import type { MutableRedactor } from '../errors/redact.js';
import { scenarioSecrets } from '../scenarios/shared/deps.js';

const NOTIFY_TOKEN_MARKER = '/u/';

/**
 * Lists the secret parts of an address: the path and the query, which carry the key of a ping or a chat.
 * @param address Address as configured.
 * @returns The parts that are not empty; none when the text is not a URL.
 */
function addressParts(address: string): string[] {
  if (!URL.canParse(address)) {
    return [];
  }

  const { pathname, search } = new URL(address);

  return [pathname, search].filter(part => part !== '' && part !== '/');
}

/**
 * Collects what must never reach a log or a message: the secrets of the scenarios, the notify address with its token, the heartbeat address with its path and the token of manual runs.
 * @param config Validated configuration.
 * @returns Redactor that learns more secrets while the process runs.
 */
export function createMasking(config: Config): MutableRedactor {
  const secrets = scenarioSecrets(config);
  const { alertNotifyUrl, heartbeat, manual } = config.monitoring;

  if (alertNotifyUrl !== undefined) {
    secrets.push(alertNotifyUrl);

    const token = alertNotifyUrl.includes(NOTIFY_TOKEN_MARKER) ? alertNotifyUrl.slice(alertNotifyUrl.indexOf(NOTIFY_TOKEN_MARKER) + NOTIFY_TOKEN_MARKER.length) : '';

    if (token !== '') {
      secrets.push(token);
    }
  }

  if (heartbeat.url !== undefined) {
    secrets.push(heartbeat.url, ...addressParts(heartbeat.url));
  }

  if (manual.token !== undefined) {
    secrets.push(manual.token);
  }

  return createMutableRedactor(secrets);
}
