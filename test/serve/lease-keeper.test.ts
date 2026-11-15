import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryLogger } from '../support/logger.js';
import { tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { leaseRenewer } from '../../src/serve/lease-keeper.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import { LEASE_KEY, claimLease } from '../../src/storage/lease.js';
import type { Lease } from '../../src/storage/lease.js';

const OURS: Lease = { pid: 1,
  hostname: 'box-a',
  nonce: 'ours',
  at: '2026-03-10T12:00:00.000Z' };

let database: TempDatabase;
let own: History;
let foreign: History;

beforeEach(async () => {
  database = await tempDatabase();
  own = createHistory(openDatabase(database.path));
  foreign = createHistory(openDatabase(database.path));
});

afterEach(async () => {
  own.close();
  foreign.close();
  await database.remove();
});

describe('leaseRenewer', () => {
  it('renews the lease with a fresh time on every call', () => {
    const exit = vi.fn<(code: number) => void>();
    const times = ['2026-03-10T12:00:30.000Z', '2026-03-10T12:01:00.000Z'];
    const renew = leaseRenewer({ history: own,
      lease: () => ({ ...OURS,
        at: times.shift() ?? OURS.at }),
      logger: memoryLogger(),
      exit,
      databasePath: database.path });

    expect(claimLease(own, OURS, new Date(OURS.at))).toEqual({ kind: 'claimed' });
    renew();
    expect(JSON.parse(foreign.getKv(LEASE_KEY) ?? '{}')).toMatchObject({ at: '2026-03-10T12:00:30.000Z' });
    renew();
    expect(JSON.parse(foreign.getKv(LEASE_KEY) ?? '{}')).toMatchObject({ at: '2026-03-10T12:01:00.000Z' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs and exits with 1 when another process took over, and returns without throwing', () => {
    const exit = vi.fn<(code: number) => void>();
    const logger = memoryLogger();
    const renew = leaseRenewer({ history: own,
      lease: () => OURS,
      logger,
      exit,
      databasePath: database.path });
    const theirs: Lease = { pid: 9,
      hostname: 'box-b',
      nonce: 'theirs',
      at: OURS.at };

    expect(claimLease(own, OURS, new Date(OURS.at))).toEqual({ kind: 'claimed' });
    foreign.setKv(LEASE_KEY, JSON.stringify(theirs));

    expect(() => {
      renew();
    }).not.toThrow();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(logger.lines).toContainEqual({ level: 'error',
      msg: 'another serve took over the database',
      databasePath: database.path });
    expect(JSON.parse(foreign.getKv(LEASE_KEY) ?? '{}')).toEqual(theirs);
  });

  it('exits when a restart of the same pid and host with another nonce took over', () => {
    const exit = vi.fn<(code: number) => void>();
    const renew = leaseRenewer({ history: own,
      lease: () => OURS,
      logger: memoryLogger(),
      exit,
      databasePath: database.path });

    expect(claimLease(own, OURS, new Date(OURS.at))).toEqual({ kind: 'claimed' });
    foreign.setKv(LEASE_KEY, JSON.stringify({ ...OURS,
      nonce: 'newer' }));
    renew();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
