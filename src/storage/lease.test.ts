import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedLease, tempDatabase } from '../test-support/database.js';
import type { TempDatabase } from '../test-support/database.js';
import { openDatabase } from './database.js';
import { createHistory } from './history.js';
import { LEASE_KEY, LEASE_TTL_MS, liveLease, releaseLease, serveLeaseOf, writeLease } from './lease.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const LEASE = { pid: 7,
  hostname: 'box',
  at: NOW.toISOString() };

let database: TempDatabase;

beforeEach(async () => {
  database = await tempDatabase();
});

afterEach(async () => {
  await database.remove();
});

/**
 * Moves the reference time.
 * @param ms Milliseconds to add.
 * @returns The moved date.
 */
function later(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

describe('lease', () => {
  it('a lease younger than the TTL is alive, an older one is not', () => {
    const history = createHistory(openDatabase(':memory:'));

    expect(liveLease(history, NOW)).toBeUndefined();
    writeLease(history, LEASE);
    expect(liveLease(history, NOW)).toEqual(LEASE);
    expect(liveLease(history, later(LEASE_TTL_MS - 1))).toEqual(LEASE);
    expect(liveLease(history, later(LEASE_TTL_MS))).toBeUndefined();
  });

  it('release removes the lease', () => {
    const history = createHistory(openDatabase(':memory:'));

    writeLease(history, LEASE);
    releaseLease(history);
    expect(liveLease(history, NOW)).toBeUndefined();
    expect(history.getKv(LEASE_KEY)).toBeUndefined();
  });

  it('a stored value that is not a lease counts as no lease', () => {
    const history = createHistory(openDatabase(':memory:'));

    history.setKv(LEASE_KEY, 'not json');
    expect(liveLease(history, NOW)).toBeUndefined();
    history.setKv(LEASE_KEY, '{"pid":"x"}');
    expect(liveLease(history, NOW)).toBeUndefined();
  });
});

describe('serveLeaseOf', () => {
  it('finds a live lease in the file and leaves the file as it was', () => {
    seedLease(database.path, LEASE);

    expect(serveLeaseOf(database.path, later(1000))).toEqual(LEASE);
    expect(serveLeaseOf(database.path, later(LEASE_TTL_MS + 1))).toBeUndefined();
  });

  it('does not create a missing file', () => {
    expect(serveLeaseOf(database.path, NOW)).toBeUndefined();
    expect(existsSync(database.path)).toBe(false);
  });

  it('treats an unreadable file as no lease', async () => {
    await writeFile(database.path, 'this is not a database');
    expect(serveLeaseOf(database.path, NOW)).toBeUndefined();
  });
});
