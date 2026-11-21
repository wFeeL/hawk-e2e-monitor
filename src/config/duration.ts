import { z } from 'zod';

/** Largest delay `setTimeout` accepts; longer values fire immediately. */
export const MAX_DURATION_MS = 2_147_483_647;

/** Options of `durationMs`. */
export interface DurationOptions {
  /** Accept 0, for waits that can be switched off. */
  allowZero?: boolean;
}

/**
 * Schema for a duration given in whole milliseconds in an environment variable.
 * @param defaultMs Value used when the variable is not set.
 * @param options Whether 0 is allowed.
 * @returns Schema that outputs a positive integer (or 0 when allowed) not above `MAX_DURATION_MS`.
 */
export function durationMs(defaultMs: number, options: DurationOptions = {}): z.ZodType<number> {
  const lowest = options.allowZero === true ? 0 : 1;

  return z.string()
    .regex(/^\d+$/, 'must be a whole number of milliseconds')
    .transform(Number)
    .pipe(
      z.number()
        .min(lowest, lowest === 0 ? 'must be 0 or more' : 'must be greater than 0')
        .max(MAX_DURATION_MS, `must not exceed ${MAX_DURATION_MS} ms`)
    )
    .default(defaultMs);
}

/**
 * Schema for a duration in whole milliseconds that must lie in a range.
 * @param defaultMs Value used when the variable is not set.
 * @param min Lowest accepted value.
 * @param max Highest accepted value.
 * @returns Schema that outputs an integer from `min` to `max`.
 */
export function boundedDurationMs(defaultMs: number, min: number, max: number): z.ZodType<number> {
  const message = `must be a whole number of milliseconds from ${String(min)} to ${String(max)}`;

  return z.string()
    .regex(/^\d+$/, message)
    .transform(Number)
    .pipe(z.number()
      .min(min, message)
      .max(max, message))
    .default(defaultMs);
}
