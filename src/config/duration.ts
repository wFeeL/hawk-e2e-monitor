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
        .int()
        .min(lowest, lowest === 0 ? 'must be 0 or more' : 'must be greater than 0')
        .max(MAX_DURATION_MS, `must not exceed ${MAX_DURATION_MS} ms`)
    )
    .default(defaultMs);
}
