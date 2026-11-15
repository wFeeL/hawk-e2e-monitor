import type { Clock } from '../time/clock.js';

/** How often and how slowly a call is repeated. */
export interface RetryPolicy {
  /** Total number of attempts, the first one included. */
  attempts: number;
  /** Waits between attempts, one fewer than the attempts; the last value repeats if there are more attempts. */
  delaysMs: readonly number[];
}

/** Attempts, delays and rules for `withRetry`. */
export interface RetryOptions {
  /** Total number of attempts, the first one included. */
  attempts: number;
  /** Waits between attempts; the last value repeats. */
  delaysMs: readonly number[];
  /** Tells whether an error is worth another attempt. */
  shouldRetry: (error: unknown) => boolean;
  /** Clock used for waiting. */
  clock: Clock;
  /** Aborts the waiting. */
  signal: AbortSignal;
}

/** Value of a successful attempt. */
export interface RetryResult<T> {
  /** What the attempt returned. */
  value: T;
  /** Number of attempts made. */
  attempts: number;
}

/**
 * Runs an attempt again after retryable errors.
 * The first attempt always runs; an abort only cuts the wait for the next one.
 * @param attempt Action; receives the attempt number from 1.
 * @param options Attempts, delays, retry rule, clock and signal.
 * @returns Value and number of attempts.
 * @throws The last error when it is not retryable, attempts ran out or the signal aborted.
 */
export async function withRetry<T>(attempt: (n: number) => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  for (let n = 1; ; n += 1) {
    try {
      return { value: await attempt(n),
        attempts: n };
    } catch (error) {
      if (n >= options.attempts || !options.shouldRetry(error) || options.signal.aborted) {
        throw error;
      }

      const delay = options.delaysMs[Math.min(n - 1, options.delaysMs.length - 1)] ?? 0;

      try {
        await options.clock.sleep(delay, options.signal);
      } catch {
        throw error;
      }
    }
  }
}
