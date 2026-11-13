import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.js';

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
