import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

/** Time source and sleeper, passed as a parameter so tests need no real waiting. */
export interface Clock {
  /**
   * Reads the monotonic clock.
   * @returns Milliseconds from an arbitrary start.
   */
  monotonicMs(): number;
  /**
   * Reads the wall clock.
   * @returns Current date.
   */
  wallTime(): Date;
  /**
   * Waits for a time.
   * @param ms Time to wait.
   * @param signal Aborts the wait.
   * @returns Resolves after `ms`, rejects with `AbortError` on abort.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Clock backed by the system timers. */
export const systemClock: Clock = {
  monotonicMs: () => performance.now(),
  wallTime: () => new Date(),
  sleep: async (ms, signal) => {
    await delay(ms, undefined, signal ? { signal } : undefined);
  },
};
