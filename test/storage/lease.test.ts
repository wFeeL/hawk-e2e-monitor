import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedLease, tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import { claimLease, LEASE_KEY, LEASE_TTL_MS, LEASE_TWIN_MARGIN_MS, liveLease, releaseLease, renewLease, serveLeaseOf, writeLease } from '../../src/storage/lease.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const LEASE = { pid: 7,
  hostname: 'box',
  nonce: 'n-1',
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
    releaseLease(history, LEASE);
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

/**
 * Opens a second connection to the temp database, as another process would.
 * @returns A history on the shared file.
 */
function connection(): History {
  return createHistory(openDatabase(database.path));
}

describe('release', () => {
  it('does not remove a lease that another start wrote', () => {
    const history = createHistory(openDatabase(':memory:'));
    const newer = { ...LEASE,
      nonce: 'n-2' };

    writeLease(history, newer);
    releaseLease(history, LEASE);
    expect(liveLease(history, NOW)).toEqual(newer);
  });
});

describe('claimLease', () => {
  it('on one file, the first claim wins and the second sees a held lease', () => {
    const first = connection();
    const second = connection();
    const other = { pid: 8,
      hostname: 'box',
      nonce: 'n-2',
      at: NOW.toISOString() };

    expect(claimLease(first, LEASE, NOW)).toEqual({ kind: 'claimed' });
    expect(claimLease(second, other, later(1000))).toEqual({ kind: 'held',
      lease: LEASE });
    expect(liveLease(second, later(1000))).toEqual(LEASE);
    first.close();
    second.close();
  });

  it('takes a lease that expired, a garbage value and its own lease again', () => {
    const history = createHistory(openDatabase(':memory:'));
    const next = { ...LEASE,
      pid: 9,
      at: later(LEASE_TTL_MS).toISOString() };

    writeLease(history, LEASE);
    expect(claimLease(history, next, later(LEASE_TTL_MS))).toEqual({ kind: 'claimed' });
    history.setKv(LEASE_KEY, 'garbage');
    expect(claimLease(history, LEASE, NOW)).toEqual({ kind: 'claimed' });
    expect(claimLease(history, LEASE, NOW)).toEqual({ kind: 'claimed' });
    expect(liveLease(history, NOW)).toEqual(LEASE);
  });

  it('reports a live lease of the same pid and host with another nonce as a twin and leaves it', () => {
    const history = createHistory(openDatabase(':memory:'));
    const restarted = { ...LEASE,
      nonce: 'n-2' };

    writeLease(history, LEASE);
    expect(claimLease(history, restarted, later(1000))).toEqual({ kind: 'twin',
      lease: LEASE });
    expect(history.getKv(LEASE_KEY)).toBe(JSON.stringify(LEASE));
  });

  it('takes a twin over when its lease did not move since it was seen', () => {
    const history = createHistory(openDatabase(':memory:'));
    const restarted = { ...LEASE,
      nonce: 'n-2' };

    writeLease(history, LEASE);
    expect(claimLease(history, restarted, later(LEASE_TWIN_MARGIN_MS), { staleAt: LEASE.at })).toEqual({ kind: 'claimed' });
    expect(liveLease(history, NOW)).toEqual(restarted);
  });

  it('refuses a twin whose lease moved since it was seen', () => {
    const history = createHistory(openDatabase(':memory:'));
    const restarted = { ...LEASE,
      nonce: 'n-2' };
    const moved = { ...LEASE,
      at: later(30_000).toISOString() };

    writeLease(history, moved);
    expect(claimLease(history, restarted, later(31_000), { staleAt: LEASE.at })).toEqual({ kind: 'held',
      lease: moved });
    expect(history.getKv(LEASE_KEY)).toBe(JSON.stringify(moved));
  });

  it('does not let staleAt override the lease of another host', () => {
    const history = createHistory(openDatabase(':memory:'));
    const foreign = { ...LEASE,
      hostname: 'other' };

    writeLease(history, foreign);
    expect(claimLease(history, LEASE, NOW, { staleAt: foreign.at })).toEqual({ kind: 'held',
      lease: foreign });
  });
});

describe('renewLease', () => {
  it('renews its own lease', () => {
    const history = createHistory(openDatabase(':memory:'));
    const renewed = { ...LEASE,
      at: later(5000).toISOString() };

    writeLease(history, LEASE);
    expect(renewLease(history, renewed)).toBe(true);
    expect(liveLease(history, NOW)).toEqual(renewed);
  });

  it('gives false when another process took over, whatever the age of its lease', () => {
    const history = createHistory(openDatabase(':memory:'));
    const foreign = { ...LEASE,
      pid: 99,
      at: new Date(NOW.getTime() - LEASE_TTL_MS * 5).toISOString() };

    writeLease(history, foreign);
    expect(renewLease(history, LEASE)).toBe(false);
    expect(history.getKv(LEASE_KEY)).toBe(JSON.stringify(foreign));
  });

  it('gives false when a start of the same pid and host with another nonce took over', () => {
    const history = createHistory(openDatabase(':memory:'));
    const newer = { ...LEASE,
      nonce: 'n-2' };

    writeLease(history, LEASE);
    writeLease(history, newer);
    expect(renewLease(history, LEASE)).toBe(false);
    expect(renewLease(history, newer)).toBe(true);
  });

  it('writes a deleted or garbled lease again', () => {
    const history = createHistory(openDatabase(':memory:'));

    expect(renewLease(history, LEASE)).toBe(true);
    expect(liveLease(history, NOW)).toEqual(LEASE);
    history.setKv(LEASE_KEY, 'garbage');
    expect(renewLease(history, LEASE)).toBe(true);
    expect(liveLease(history, NOW)).toEqual(LEASE);
  });
});

describe('serveLeaseOf', () => {
  it('finds a live lease in the file and leaves the file as it was', () => {
    seedLease(database.path, LEASE);

    expect(serveLeaseOf(database.path, later(1000))).toEqual({ kind: 'live',
      lease: LEASE });
    expect(serveLeaseOf(database.path, later(LEASE_TTL_MS + 1))).toEqual({ kind: 'none' });
  });

  it('does not create a missing file', () => {
    expect(serveLeaseOf(database.path, NOW)).toEqual({ kind: 'none' });
    expect(existsSync(database.path)).toBe(false);
  });

  it('treats a file of 0 bytes as no lease, because serve always writes the schema first', async () => {
    await writeFile(database.path, '');
    expect(serveLeaseOf(database.path, NOW)).toEqual({ kind: 'none' });
  });

  it('reports a file that is not a database as unreadable with the reason', async () => {
    await writeFile(database.path, 'this is not a database');

    const lookup = serveLeaseOf(database.path, NOW);

    expect(lookup.kind).toBe('unreadable');
    expect(lookup).toMatchObject({ error: expect.stringMatching(/\S/u) as string });
  });
});
