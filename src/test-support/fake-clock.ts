import type { Clock } from '../time/clock.js';

/** Clock whose time moves only through `advance`. */
export interface FakeClock extends Clock {
  /**
   * Moves time forward and resolves every sleep that falls due, including sleeps created on the way.
   * @param ms Time to move forward.
   * @returns Resolves once the work triggered by the sleeps has settled.
   */
  advance(ms: number): Promise<void>;
  /**
   * Counts sleeps that are neither resolved nor aborted.
   * @returns Number of waiting sleeps.
   */
  pending(): number;
}

/** Start values of a fake clock. */
export interface FakeClockStart {
  /** Initial monotonic reading, 0 by default. */
  monotonicMs?: number;
  /** Initial wall time, 2026-01-01T00:00:00Z by default. */
  wall?: Date;
}

/** One pending sleep. */
interface Sleeper {
  /** Monotonic time when the sleep ends. */
  wake: number;
  /** Creation order, to break ties between equal wake times. */
  seq: number;
  /** Ends the sleep normally. */
  resolve: () => void;
  /** Ends the sleep with `AbortError`. */
  abort: () => void;
}

/**
 * Lets chained microtasks settle by yielding a real macrotask.
 * @returns Resolves after the next `setImmediate`.
 */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

/**
 * Creates a clock for tests of deadlines and polling.
 * @param start Initial readings.
 * @returns Fake clock with `advance` and `pending`.
 */
export function createFakeClock(start: FakeClockStart = {}): FakeClock {
  const startMonotonic = start.monotonicMs ?? 0;
  const startWall = (start.wall ?? new Date('2026-01-01T00:00:00Z')).getTime();
  let now = startMonotonic;
  let seq = 0;
  const sleepers = new Set<Sleeper>();

  const earliest = (): Sleeper | undefined => [...sleepers].sort((a, b) => a.wake - b.wake || a.seq - b.seq)[0];

  const sleep: FakeClock['sleep'] = async (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('The operation was aborted', 'AbortError'));

      return;
    }

    seq += 1;
    const sleeper: Sleeper = { wake: now + Math.max(ms, 0),
      seq,
      resolve: () => {
        signal?.removeEventListener('abort', sleeper.abort);
        resolve();
      },
      abort: () => {
        sleepers.delete(sleeper);
        reject(new DOMException('The operation was aborted', 'AbortError'));
      } };

    signal?.addEventListener('abort', sleeper.abort, { once: true });
    sleepers.add(sleeper);
  });

  const advance: FakeClock['advance'] = async (ms) => {
    const target = now + ms;

    await flush();

    for (let next = earliest(); next !== undefined && next.wake <= target; next = earliest()) {
      sleepers.delete(next);
      now = Math.max(now, next.wake);
      next.resolve();
      await flush();
    }

    now = target;
  };

  return {
    monotonicMs: () => now,
    wallTime: () => new Date(startWall + (now - startMonotonic)),
    sleep,
    pending: () => sleepers.size,
    advance,
  };
}
