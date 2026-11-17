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

/** A signal that aborts when a sleep on the clock ends, and a way to cancel that sleep. */
export interface TimeoutSignal {
  /** Aborts with a `DOMException` named `TimeoutError` after the time passed. */
  signal: AbortSignal;
  /** Cancels the sleep; the signal then never aborts. Safe to call twice. */
  dispose(): void;
}

/**
 * Builds a deadline on the clock, so tests move it with their fake clock.
 * @param clock Clock whose `sleep` measures the time.
 * @param ms Time before the abort.
 * @returns The signal and its disposer.
 */
export function timeoutSignal(clock: Clock, ms: number): TimeoutSignal {
  const controller = new AbortController();
  const cancel = new AbortController();

  // A cancelled sleep rejects; that is the normal end of a deadline that was not needed.
  clock.sleep(ms, cancel.signal).then(() => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, () => undefined);

  return { signal: controller.signal,
    dispose: () => {
      cancel.abort();
    } };
}
