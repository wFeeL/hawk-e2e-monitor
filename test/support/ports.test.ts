import { spawnSync } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reservedPort } from './ports.js';

const LOCK_DIR = join(tmpdir(), 'hawk-e2e-monitor-ports');
const servers: Server[] = [];
const locks: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  for (const path of locks.splice(0)) {
    try {
      unlinkSync(path);
    } catch {
      // The code under test may have removed it already.
    }
  }

  await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  })));
});

/**
 * Gives a start port that differs between test processes, so parallel runs do not fight over the same one.
 * @param slot Which of the three tests asks.
 * @returns Port in the searched range with room for the next one.
 */
function portFor(slot: number): number {
  return 20_000 + (process.pid * 7 + slot * 3000) % 9000;
}

/**
 * Makes the search start at a known port: the start is `20000 + floor(random * 10000)`.
 * @param port Port the search should start from.
 */
function startAt(port: number): void {
  vi.spyOn(Math, 'random').mockReturnValue((port - 20_000 + 0.5) / 10_000);
}

/**
 * Binds a loopback port for the length of the test.
 * @param port Port to bind.
 * @returns Resolves when the server listens.
 */
async function occupy(port: number): Promise<void> {
  const server = createServer();

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
}

/**
 * Writes the lock file of a port as another process would.
 * @param port Port the lock file stands for.
 * @param pid Process id to write into it.
 */
function lock(port: number, pid: number): void {
  const path = join(LOCK_DIR, `${String(port)}.lock`);

  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(path, String(pid));
  locks.push(path);
}

describe('reservedPort', () => {
  it('gives a different port on every call', async () => {
    const first = await reservedPort();
    const second = await reservedPort();

    expect(second).not.toBe(first);
  });

  it('stays below the ports that listen(0) hands out', async () => {
    const port = await reservedPort();

    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(port).toBeLessThan(32_768);
  });

  it('skips a port that something already listens on', async () => {
    const port = portFor(0);

    startAt(port);
    await occupy(port);

    expect(await reservedPort()).toBe(port + 1);
  });

  it('skips a port that a live process has locked', async () => {
    const port = portFor(1);

    startAt(port);
    lock(port, process.pid);

    expect(await reservedPort()).toBe(port + 1);
  });

  it('takes over the lock of a process that is gone', async () => {
    const { pid } = spawnSync(process.execPath, ['-e', '']);

    const port = portFor(2);

    startAt(port);
    lock(port, pid);

    expect(await reservedPort()).toBe(port);
  });
});
