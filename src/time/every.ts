import type { Clock } from './clock.js';

/**
 * Runs `action` every `periodMs` until the signal aborts; a failure is reported and the loop goes on.
 * @param clock Sleeper.
 * @param periodMs Pause between runs.
 * @param signal Stops the loop.
 * @param action What to do.
 * @param onError Called with a failure of `action`.
 * @returns Resolves when the loop ended.
 */
export async function every(clock: Clock, periodMs: number, signal: AbortSignal, action: () => void, onError: (error: unknown) => void): Promise<void> {
  for (;;) {
    try {
      await clock.sleep(periodMs, signal);
    } catch {
      return;
    }

    try {
      action();
    } catch (error) {
      onError(error);
    }
  }
}
