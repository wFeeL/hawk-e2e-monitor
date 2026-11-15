import { describe, expect, it } from 'vitest';
import { every } from '../../src/time/every.js';
import { createFakeClock } from '../support/fake-clock.js';

describe('every', () => {
  it('runs the action each period and ends when the signal aborts', async () => {
    const clock = createFakeClock();
    const stop = new AbortController();
    let calls = 0;
    const loop = every(clock, 100, stop.signal, () => {
      calls += 1;
    }, () => undefined);

    await clock.advance(250);
    expect(calls).toBe(2);

    stop.abort();
    await loop;
    await clock.advance(500);
    expect(calls).toBe(2);
  });

  it('reports a failure of the action and goes on', async () => {
    const clock = createFakeClock();
    const stop = new AbortController();
    const errors: unknown[] = [];
    let calls = 0;
    const loop = every(clock, 100, stop.signal, () => {
      calls += 1;
      throw new Error('boom');
    }, (error) => {
      errors.push(error);
    });

    await clock.advance(250);
    stop.abort();
    await loop;

    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
  });
});
