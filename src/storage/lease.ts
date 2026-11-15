import { existsSync } from 'node:fs';
import { openDatabase } from './database.js';
import { createHistory } from './history.js';
import type { History } from './history.js';

/** Key in `kv` that holds the lease of the running `serve`. */
export const LEASE_KEY = 'serve_lease';

/** How often `serve` renews its lease. */
export const LEASE_REFRESH_MS = 30_000;

/** Extra wait of a start that met a twin lease, on top of one renewal period. */
export const LEASE_TWIN_MARGIN_MS = 5000;

/** Age after which a lease no longer counts as alive. */
export const LEASE_TTL_MS = 90_000;

/** Claim of a `serve` process on a database. */
export interface Lease {
  /** Process id of `serve`. */
  pid: number;
  /** Host name of the machine or container `serve` runs on. */
  hostname: string;
  /** Random value of one `serve` start; tells two starts apart that share a pid, as in containers. */
  nonce: string;
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
          // Leases written before the nonce existed have none.
          nonce: typeof parsed.nonce === 'string' ? parsed.nonce : '',
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

/** The claim succeeded. */
export interface LeaseClaimed {
  /** Discriminant. */
  kind: 'claimed';
}

/** A live lease of another process holds the database. */
export interface LeaseHeld {
  /** Discriminant. */
  kind: 'held';
  /** The lease that blocks the claim. */
  lease: Lease;
}

/** A live lease with the same pid and host name but another start. It may be a predecessor that is gone, or a live twin. */
export interface LeaseTwin {
  /** Discriminant. */
  kind: 'twin';
  /** The lease found. */
  lease: Lease;
}

/** Result of a claim: ours now, held by a live other process, or left by a start with the same pid and host name. */
export type LeaseClaim = LeaseClaimed | LeaseHeld | LeaseTwin;

/** Options of `claimLease`. */
export interface ClaimOptions {
  /** `at` of a twin lease seen earlier; a twin lease that still has this `at` did not renew and counts as dead. */
  staleAt?: string;
}

/**
 * Tells whether two leases come from the same host and process id.
 * @param left One lease.
 * @param right Another lease.
 * @returns True when pid and host name are equal.
 */
function sameProcess(left: Lease, right: Lease): boolean {
  return left.pid === right.pid && left.hostname === right.hostname;
}

/**
 * Writes the lease unless a live lease of another process is stored; check and write are one transaction.
 * A live lease with the same pid and host name but another nonce is a twin: after a container restart it is
 * the predecessor, but a second live process in another container looks the same, so the caller must wait
 * one renewal period and claim again with `staleAt`.
 * @param history History of the database `serve` wants to own.
 * @param lease Claim to store.
 * @param now Current wall-clock time.
 * @param options Evidence from an earlier claim.
 * @returns `claimed`, `held` with the lease of the other process, or `twin`.
 */
export function claimLease(history: History, lease: Lease, now: Date, options: ClaimOptions = {}): LeaseClaim {
  let blocked: LeaseClaim | undefined = undefined as LeaseClaim | undefined;

  history.updateKv(LEASE_KEY, (current) => {
    const stored = parseLease(current);

    if (stored === undefined || now.getTime() - Date.parse(stored.at) >= LEASE_TTL_MS) {
      return JSON.stringify(lease);
    }

    if (!sameProcess(stored, lease)) {
      blocked = { kind: 'held',
        lease: stored };

      return undefined;
    }

    if (stored.nonce === lease.nonce || stored.at === options.staleAt) {
      return JSON.stringify(lease);
    }

    blocked = options.staleAt === undefined
      ? { kind: 'twin',
          lease: stored }
      : { kind: 'held',
          lease: stored };

    return undefined;
  });

  return blocked ?? { kind: 'claimed' };
}

/**
 * Renews the lease.
 * @param history History of the database `serve` owns.
 * @param lease Claim to store.
 * @returns False when the stored lease belongs to another process or another start, whatever its age.
 * A missing or unreadable lease is written again.
 */
export function renewLease(history: History, lease: Lease): boolean {
  let renewed = true;

  history.updateKv(LEASE_KEY, (current) => {
    const stored = parseLease(current);

    if (stored !== undefined && (!sameProcess(stored, lease) || stored.nonce !== lease.nonce)) {
      renewed = false;

      return undefined;
    }

    return JSON.stringify(lease);
  });

  return renewed;
}

/**
 * Removes the lease, so the next start does not wait for it to expire.
 * Leaves it alone when another start has written its own meanwhile.
 * @param history History of the database `serve` owns.
 * @param lease The claim of this start.
 */
export function releaseLease(history: History, lease: Lease): void {
  history.updateKv(LEASE_KEY, (current) => {
    return parseLease(current)?.nonce === lease.nonce ? null : undefined;
  });
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
