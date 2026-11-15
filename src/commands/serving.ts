import type { Config } from '../config/load.js';
import { serveLeaseOf } from '../storage/lease.js';
import { MS_PER_SECOND } from '../time/units.js';

/**
 * Tells whether a CLI command must stay out of the way of a running `serve`.
 * @param config Validated configuration.
 * @param now Current wall-clock time.
 * @returns The text for stderr when a live `serve` holds the database or the file cannot be checked, otherwise undefined.
 */
export function refusalWhileServing(config: Config, now: Date): string | undefined {
  const { databasePath } = config.monitoring;
  const lookup = serveLeaseOf(databasePath, now);

  switch (lookup.kind) {
    case 'none':
      return undefined;
    case 'unreadable':
      return `cannot open ${databasePath} to look for a running serve: ${lookup.error}; check the permissions of the file and of its -wal and -shm files\n`;
    case 'live': {
      const { lease } = lookup;
      const age = Math.max(0, Math.floor((now.getTime() - Date.parse(lease.at)) / MS_PER_SECOND));

      return `serve is running for ${databasePath} (lease ${String(age)} s old, pid ${String(lease.pid)}); stop it first or start the run through serve\n`;
    }
  }
}
