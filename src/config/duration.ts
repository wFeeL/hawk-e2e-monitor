import { z } from 'zod';

/** Largest delay `setTimeout` accepts; longer values fire immediately. */
export const MAX_DURATION_MS = 2_147_483_647;

/**
 * Schema for a duration given in whole milliseconds in an environment variable.
 * @param defaultMs Value used when the variable is not set.
 * @returns Schema that outputs a positive integer not above `MAX_DURATION_MS`.
 */
export function durationMs(defaultMs: number): z.ZodType<number> {
  return z.string()
    .regex(/^\d+$/, 'must be a whole number of milliseconds')
    .transform(Number)
    .pipe(
      z.number()
        .int()
        .gt(0, 'must be greater than 0')
        .max(MAX_DURATION_MS, `must not exceed ${MAX_DURATION_MS} ms`)
    )
    .default(defaultMs);
}
