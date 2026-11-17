import { setTimeout as sleep } from 'node:timers/promises';
import { countPortLocks, sweepPortLocks } from './ports.js';

const TEARDOWN_TRIES = 30;
const TEARDOWN_STEP_MS = 100;

/**
 * Removes the port locks that earlier runs left behind.
 */
export function setup(): void {
  sweepPortLocks();
}

/**
 * Removes the port locks of this run's workers.
 * A worker can still be shutting down when vitest calls this, so it sweeps again for a few seconds until the directory is empty.
 * @returns Resolves when the locks are gone or the time is up.
 */
export async function teardown(): Promise<void> {
  for (let tried = 0; tried < TEARDOWN_TRIES; tried += 1) {
    sweepPortLocks();

    if (countPortLocks() === 0) {
      return;
    }

    await sleep(TEARDOWN_STEP_MS);
  }
}
