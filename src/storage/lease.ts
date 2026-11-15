import { existsSync } from 'node:fs';
import { openDatabase } from './database.js';
import { createHistory } from './history.js';
import type { History } from './history.js';

/** Key in `kv` that holds the lease of the running `serve`. */
export const LEASE_KEY = 'serve_lease';

/** How often `serve` renews its lease. */
export const LEASE_REFRESH_MS = 30_000;

/** Age after which a lease no longer counts as alive. */
export const LEASE_TTL_MS = 90_000;

/** Claim of a `serve` process on a database. */
export interface Lease {
  /** Process id of `serve`. */
  pid: number;
  /** Host name of the machine or container `serve` runs on. */
  hostname: string;
  /** Wall-clock time of the last renewal, ISO. */
  at: string;
}

/**
 * Parses a stored lease.
 * @param value Text from `kv`.
 * @returns The lease, or undefined when the text is not one.
 */
function parseLease(value: string | undefined): Lease | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as Partial<Lease> | null;

    return typeof parsed?.pid === 'number' && typeof parsed.hostname === 'string' && typeof parsed.at === 'string'
      ? { pid: parsed.pid,
          hostname: parsed.hostname,
          at: parsed.at }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes or renews the lease.
 * @param history History of the database `serve` owns.
 * @param lease Claim to store.
 */
export function writeLease(history: History, lease: Lease): void {
  history.setKv(LEASE_KEY, JSON.stringify(lease));
}

/**
 * Removes the lease, so the next start does not wait for it to expire.
 * @param history History of the database `serve` owns.
 */
export function releaseLease(history: History): void {
  history.deleteKv(LEASE_KEY);
}

/**
 * Reads the lease if it is alive.
 * @param history History to read.
 * @param now Current wall-clock time.
 * @returns Lease younger than `LEASE_TTL_MS`, otherwise undefined.
 */
export function liveLease(history: History, now: Date): Lease | undefined {
  const lease = parseLease(history.getKv(LEASE_KEY));

  return lease !== undefined && now.getTime() - Date.parse(lease.at) < LEASE_TTL_MS ? lease : undefined;
}

/**
 * Looks for a running `serve` from a CLI command.
 * Opens the database read-only and only when the file exists; anything unreadable counts as no lease.
 * @param databasePath Path of the history file.
 * @param now Current wall-clock time.
 * @returns The live lease, or undefined.
 */
export function serveLeaseOf(databasePath: string, now: Date): Lease | undefined {
  if (!existsSync(databasePath)) {
    return undefined;
  }

  try {
    const history = createHistory(openDatabase(databasePath, { readOnly: true }));

    try {
      return liveLease(history, now);
    } finally {
      history.close();
    }
  } catch {
    return undefined;
  }
}
