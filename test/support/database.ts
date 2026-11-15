import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { writeLease } from '../../src/storage/lease.js';
import type { Lease } from '../../src/storage/lease.js';

/** A history file in a temporary directory. */
export interface TempDatabase {
  /** Path of the file; it does not exist until something opens it for writing. */
  path: string;
  /**
   * Removes the directory.
   * @returns Resolves when it is gone.
   */
  remove(): Promise<void>;
}

/**
 * Reserves a path for a history file in a fresh temporary directory.
 * @returns The path and a way to clean up.
 */
export async function tempDatabase(): Promise<TempDatabase> {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-db-'));

  return { path: join(directory, 'monitor.db'),
    remove: async () => rm(directory, { recursive: true,
      force: true }) };
}

/** A lease for `seedLease`; the nonce is optional. */
export type SeededLease = Omit<Lease, 'nonce'> & Partial<Pick<Lease, 'nonce'>>;

/**
 * Writes a lease into a database file, creating the file when needed.
 * @param path Path of the history file.
 * @param lease Claim to store; the nonce defaults to `seed`.
 */
export function seedLease(path: string, lease: SeededLease): void {
  const history = createHistory(openDatabase(path));

  writeLease(history, { nonce: 'seed',
    ...lease });
  history.close();
}
