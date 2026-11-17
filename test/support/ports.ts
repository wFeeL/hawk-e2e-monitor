import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const FIRST_PORT = 20_000;
const PORT_COUNT = 10_000;
const MAX_TRIES = 200;
const LOCK_DIR = join(tmpdir(), 'hawk-e2e-monitor-ports');

/**
 * Tells whether a process with this id exists.
 * @param pid Process id read from a lock file.
 * @returns False when the system says there is no such process, or when the file holds no valid id.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Creates the lock file of a port for this process.
 * @param path File that marks the port as taken.
 * @returns True when the lock is ours; false when the file exists, whoever holds it.
 * @throws Error for a failure other than an existing file.
 */
function lockFile(path: string): boolean {
  try {
    const fd = openSync(path, 'wx');

    writeSync(fd, String(process.pid));
    closeSync(fd);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }

    throw error;
  }
}

/**
 * Counts the lock files that exist.
 * @returns Number of files in the lock directory; 0 when the directory is missing.
 */
export function countPortLocks(): number {
  try {
    return readdirSync(LOCK_DIR).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw error;
  }
}

/**
 * Removes the lock files of processes that are gone.
 * Only the vitest main process calls this, before and after a run; a worker never takes a lock over.
 * @returns How many files it removed.
 */
export function sweepPortLocks(): number {
  let removed = 0;
  let names: string[];

  try {
    names = readdirSync(LOCK_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }

    throw error;
  }

  for (const name of names) {
    const path = join(LOCK_DIR, name);

    try {
      if (!isAlive(Number(readFileSync(path, 'utf8')))) {
        unlinkSync(path);
        removed += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  return removed;
}

/**
 * Tells whether a loopback port can be bound right now.
 * @param port Port to try.
 * @returns True when the bind worked; false when the port is taken.
 * @throws Error for a failure other than a taken port.
 */
async function isFree(port: number): Promise<boolean> {
  const probe = createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      return false;
    }

    throw error;
  }

  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });

  return true;
}

/**
 * Gives a loopback port nothing listens on, from a range that `listen(0)` never hands out, locked by a file so that no
 * other test process takes it before the caller uses it.
 * @returns Port that was free when checked.
 * @throws Error when no candidate could be taken.
 */
export async function reservedPort(): Promise<number> {
  mkdirSync(LOCK_DIR, { recursive: true });

  const start = Math.floor(Math.random() * PORT_COUNT);

  for (let tried = 0; tried < MAX_TRIES; tried += 1) {
    const port = FIRST_PORT + (start + tried) % PORT_COUNT;
    const path = join(LOCK_DIR, `${String(port)}.lock`);

    if (lockFile(path)) {
      if (await isFree(port)) {
        return port;
      }

      unlinkSync(path);
    }
  }

  throw new Error(`No free port found after ${String(MAX_TRIES)} tries from ${String(FIRST_PORT + start)}`);
}
