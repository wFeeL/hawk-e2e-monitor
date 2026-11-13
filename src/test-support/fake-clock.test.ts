import { describe, expect, it } from 'vitest';
import { createFakeClock } from './fake-clock.js';

describe('createFakeClock', () => {
  it('resolves sleeps in wake order and moves the clocks', async () => {
    const clock = createFakeClock();
    const order: number[] = [];
    const slow = clock.sleep(200).then(() => order.push(200));
    const fast = clock.sleep(100).then(() => order.push(100));

    expect(clock.pending()).toBe(2);
    await clock.advance(250);
    await Promise.all([slow, fast]);

    expect(order).toEqual([100, 200]);
    expect(clock.monotonicMs()).toBe(250);
    expect(clock.wallTime().toISOString()).toBe('2026-01-01T00:00:00.250Z');
    expect(clock.pending()).toBe(0);
  });

  it('resolves sleeps created while advancing', async () => {
    const clock = createFakeClock();
    const wakes: number[] = [];
    const loop = (async () => {
      await clock.sleep(100);
      wakes.push(clock.monotonicMs());
      await clock.sleep(100);
      wakes.push(clock.monotonicMs());
    })();

    await clock.advance(500);
    await loop;

    expect(wakes).toEqual([100, 200]);
    expect(clock.monotonicMs()).toBe(500);
  });

  it('rejects with AbortError on abort and drops the sleep', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(100, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' });
    expect(clock.pending()).toBe(0);
    await expect(clock.sleep(1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves a zero sleep on advance(0)', async () => {
    const clock = createFakeClock({ monotonicMs: 10 });
    let done = false;
    const zero = clock.sleep(0).then(() => {
      done = true;
    });

    expect(done).toBe(false);
    await clock.advance(0);
    await zero;

    expect(done).toBe(true);
    expect(clock.monotonicMs()).toBe(10);
  });
});
