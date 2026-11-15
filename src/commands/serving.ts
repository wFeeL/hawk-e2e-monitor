import type { Config } from '../config/load.js';
import { serveLeaseOf } from '../storage/lease.js';

const MS_PER_SECOND = 1000;

/**
 * Tells whether a CLI command must stay out of the way of a running `serve`.
 * @param config Validated configuration.
 * @param now Current wall-clock time.
 * @returns The text for stderr when a live `serve` holds the database, otherwise undefined.
 */
export function refusalWhileServing(config: Config, now: Date): string | undefined {
  const { databasePath } = config.monitoring;
  const lease = serveLeaseOf(databasePath, now);

  if (lease === undefined) {
    return undefined;
  }

  const age = Math.max(0, Math.floor((now.getTime() - Date.parse(lease.at)) / MS_PER_SECOND));

  return `serve is running for ${databasePath} (lease ${String(age)} s old, pid ${String(lease.pid)}); stop it first or start the run through serve\n`;
}
