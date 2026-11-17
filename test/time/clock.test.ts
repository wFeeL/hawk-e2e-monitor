import { describe, expect, it } from 'vitest';
import { systemClock, timeoutSignal } from '../../src/time/clock.js';
import { createFakeClock } from '../support/fake-clock.js';

describe('systemClock', () => {
  it('sleep resolves', async () => {
    const before = systemClock.monotonicMs();

    await systemClock.sleep(20);

    expect(systemClock.monotonicMs() - before).toBeGreaterThanOrEqual(15);
    expect(systemClock.wallTime()).toBeInstanceOf(Date);
  });

  it('sleep rejects on abort', async () => {
    const controller = new AbortController();
    const sleeping = systemClock.sleep(5000, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' });
    await expect(systemClock.sleep(5000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('timeoutSignal', () => {
  it('aborts with TimeoutError when the clock passes the time', async () => {
    const clock = createFakeClock();
    const { signal } = timeoutSignal(clock, 5000);

    await clock.advance(4999);
    expect(signal.aborted).toBe(false);
    await clock.advance(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('dispose cancels the sleep', async () => {
    const clock = createFakeClock();
    const deadline = timeoutSignal(clock, 5000);

    expect(clock.pending()).toBe(1);
    deadline.dispose();
    deadline.dispose();
    expect(clock.pending()).toBe(0);
    await clock.advance(5000);
    expect(deadline.signal.aborted).toBe(false);
  });
});
