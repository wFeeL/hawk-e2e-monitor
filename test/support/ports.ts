import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const FIRST_PORT = 20_000;
const PORT_COUNT = 10_000;
const MAX_TRIES = 200;
const LOCK_DIR = join(tmpdir(), 'hawk-e2e-monitor-ports');

const own = new Set<string>();
let exitHooked = false;

/**
 * Removes the lock files this process created.
 */
function releaseAll(): void {
  for (const path of own) {
    try {
      unlinkSync(path);
    } catch {
      // Someone removed it already.
    }
  }
}

/**
 * Tells whether a process with this id exists.
 * @param pid Process id read from a lock file.
 * @returns False only when the system says there is no such process.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
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
 * @returns True when the lock is ours.
 * @throws Error for a failure other than an existing file.
 */
function lockFile(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');

      writeSync(fd, String(process.pid));
      closeSync(fd);

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      // An empty file is a lock that is being written; treat its owner as alive.
      if (isAlive(Number(readFileSync(path, 'utf8')))) {
        return false;
      }

      unlinkSync(path);
    }
  }

  return false;
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
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', releaseAll);
  }

  mkdirSync(LOCK_DIR, { recursive: true });

  const start = Math.floor(Math.random() * PORT_COUNT);

  for (let tried = 0; tried < MAX_TRIES; tried += 1) {
    const port = FIRST_PORT + (start + tried) % PORT_COUNT;
    const path = join(LOCK_DIR, `${String(port)}.lock`);

    if (lockFile(path)) {
      own.add(path);

      if (await isFree(port)) {
        return port;
      }

      own.delete(path);
      unlinkSync(path);
    }
  }

  throw new Error(`No free port found after ${String(MAX_TRIES)} tries from ${String(FIRST_PORT + start)}`);
}
