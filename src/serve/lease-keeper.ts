import type { Logger } from '../log/logger.js';
import type { History } from '../storage/history.js';
import { renewLease } from '../storage/lease.js';
import type { Lease } from '../storage/lease.js';

/** What renewing the lease needs. */
export interface LeaseKeeperDeps {
  /** History of the database `serve` owns. */
  history: History;
  /** Builds the claim of this process with the current time. */
  lease: () => Lease;
  /** Logger of the process. */
  logger: Logger;
  /** Ends the process. */
  exit: (code: number) => void;
  /** Path of the database, for the log line. */
  databasePath: string;
}

/**
 * Builds the renewal callback: renews the lease, or logs and exits with 1 when another process holds it.
 * Two processes on one database would both send events and alerts, so the older one must stop.
 * @param deps Parts the callback works with.
 * @returns Callback for the renewal loop; it does not throw after the exit.
 */
export function leaseRenewer(deps: LeaseKeeperDeps): () => void {
  return (): void => {
    if (!renewLease(deps.history, deps.lease())) {
      deps.logger.error('another serve took over the database', { databasePath: deps.databasePath });
      deps.exit(1);
    }
  };
}
