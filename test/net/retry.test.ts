import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/time/clock.js';
import { withRetry } from '../../src/net/retry.js';

describe('withRetry', () => {
  it('retries only when allowed and stops at attempts', async () => {
    const seen: number[] = [];
    const signal = new AbortController().signal;
    const result = await withRetry((n) => {
      seen.push(n);

      return n < 3 ? Promise.reject(new Error('retry me')) : Promise.resolve('done');
    }, { attempts: 3,
      delaysMs: [1],
      shouldRetry: () => true,
      clock: systemClock,
      signal });

    expect(result).toEqual({ value: 'done',
      attempts: 3 });
    expect(seen).toEqual([1, 2, 3]);

    let calls = 0;

    await expect(withRetry(() => {
      calls += 1;

      return Promise.reject(new Error('always'));
    }, { attempts: 3,
      delaysMs: [1],
      shouldRetry: () => true,
      clock: systemClock,
      signal })).rejects.toThrow('always');
    expect(calls).toBe(3);

    calls = 0;
    await expect(withRetry(() => {
      calls += 1;

      return Promise.reject(new Error('fatal'));
    }, { attempts: 3,
      delaysMs: [1],
      shouldRetry: () => false,
      clock: systemClock,
      signal })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('withRetry stops on abort', async () => {
    const controller = new AbortController();
    let calls = 0;
    const running = withRetry(() => {
      calls += 1;
      setTimeout(() => {
        controller.abort();
      }, 5);

      return Promise.reject(new Error('last error'));
    }, { attempts: 3,
      delaysMs: [1000],
      shouldRetry: () => true,
      clock: systemClock,
      signal: controller.signal });

    await expect(running).rejects.toThrow('last error');
    expect(calls).toBe(1);
  });

  it('runs the first attempt even when the signal is already aborted', async () => {
    const controller = new AbortController();

    controller.abort();

    const result = await withRetry(() => Promise.resolve(1), { attempts: 3,
      delaysMs: [1],
      shouldRetry: () => true,
      clock: systemClock,
      signal: controller.signal });

    expect(result.attempts).toBe(1);
  });
});
