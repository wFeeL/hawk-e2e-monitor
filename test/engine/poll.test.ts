import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/errors/taxonomy.js';
import { createFakeClock } from '../support/fake-clock.js';
import { pollUntil } from '../../src/engine/poll.js';
import type { PollObservation } from '../../src/engine/poll.js';

const apiDown = (): PollObservation<string> => ({ kind: 'error',
  error: new CheckError('api_unavailable', { code: 'ECONNREFUSED' }) });
const absent = (): PollObservation<string> => ({ kind: 'absent' });

describe('pollUntil', () => {
  it('found on third attempt', async () => {
    const clock = createFakeClock();
    const signal = new AbortController().signal;
    let calls = 0;
    const polling = pollUntil((): Promise<PollObservation<string>> => {
      calls += 1;

      return Promise.resolve(calls < 3
        ? absent()
        : { kind: 'found',
            value: 'event' });
    }, { clock,
      signal,
      random: () => 0.5 });

    await clock.advance(10_000);

    expect(await polling).toEqual({ outcome: 'found',
      value: 'event',
      attempts: 3,
      errors: 0,
      startedAtMs: 0,
      foundAtMs: 1500 });
  });

  it('schedule is 500, 1000, 2000, 4000, 5000, 5000', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const times: number[] = [];
    const polling = pollUntil(() => {
      times.push(clock.monotonicMs());

      return Promise.resolve(absent());
    }, { clock,
      signal: controller.signal,
      random: () => 0.5 });

    await clock.advance(17_500);
    controller.abort();
    await polling;

    expect(times).toEqual([0, 500, 1500, 3500, 7500, 12_500, 17_500]);
  });

  it('jitter stays within 20 percent', async () => {
    for (const [random, expected] of [[0, 400], [1, 600]] as const) {
      const clock = createFakeClock();
      const controller = new AbortController();
      const times: number[] = [];
      const polling = pollUntil(() => {
        times.push(clock.monotonicMs());

        return Promise.resolve(absent());
      }, { clock,
        signal: controller.signal,
        random: () => random });

      await clock.advance(expected);
      controller.abort();
      await polling;

      expect(times).toEqual([0, expected]);
    }
  });

  it('not_found when API answered and never found', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const answers = [absent, apiDown, absent];
    let calls = 0;
    const polling = pollUntil(() => {
      const answer = answers[Math.min(calls, answers.length - 1)];

      calls += 1;

      return Promise.resolve(answer?.() ?? absent());
    }, { clock,
      signal: controller.signal,
      random: () => 0.5 });

    await clock.advance(1500);
    controller.abort();

    expect(await polling).toEqual({ outcome: 'not_found',
      attempts: 3,
      successes: 2,
      errors: 1,
      startedAtMs: 0,
      lastSuccessAtMs: 1500 });
  });

  it('api_error when no attempt succeeded', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const polling = pollUntil(() => Promise.resolve(apiDown()), { clock,
      signal: controller.signal,
      random: () => 0.5 });

    await clock.advance(500);
    controller.abort();
    const result = await polling;

    expect(result).toMatchObject({ outcome: 'api_error',
      attempts: 2,
      errors: 2,
      startedAtMs: 0 });
    expect(result.outcome === 'api_error' && result.lastError.errorClass).toBe('api_unavailable');
  });

  it('API down for 10 s mid-poll, then found', async () => {
    const clock = createFakeClock();
    const signal = new AbortController().signal;
    const polling = pollUntil((): Promise<PollObservation<string>> => {
      const now = clock.monotonicMs();

      if (now >= 1000 && now < 11_000) {
        return Promise.resolve(apiDown());
      }

      return Promise.resolve(now >= 11_000
        ? { kind: 'found',
            value: 'event' }
        : absent());
    }, { clock,
      signal,
      random: () => 0.5 });

    await clock.advance(30_000);
    const result = await polling;

    expect(result.outcome).toBe('found');
    expect(result.errors).toBeGreaterThanOrEqual(1);
  });

  it('aborted probe is not counted', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    let calls = 0;
    const polling = pollUntil((): Promise<PollObservation<string>> => {
      calls += 1;

      if (calls === 1) {
        return Promise.resolve(absent());
      }

      controller.abort();

      return Promise.resolve(apiDown());
    }, { clock,
      signal: controller.signal,
      random: () => 0.5 });

    await clock.advance(500);

    expect(await polling).toMatchObject({ outcome: 'not_found',
      attempts: 1,
      successes: 1,
      errors: 0 });
  });

  it('empty outcome when every probe was cut off', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const result = await pollUntil(() => {
      controller.abort();

      return Promise.resolve(absent());
    }, { clock,
      signal: controller.signal });

    expect(result).toMatchObject({ outcome: 'api_error',
      attempts: 0,
      errors: 0 });
    expect(result.outcome === 'api_error' && result.lastError.facts.code).toBe('TIMEOUT');
  });

  it('rethrows a foreign exception unless aborted', async () => {
    const clock = createFakeClock();
    const signal = new AbortController().signal;

    await expect(pollUntil(() => Promise.reject(new Error('bug')), { clock,
      signal })).rejects.toThrow('bug');
  });

  it('rejects an empty schedule', async () => {
    const clock = createFakeClock();
    const signal = new AbortController().signal;

    await expect(pollUntil(() => Promise.resolve(absent()), { clock,
      signal,
      scheduleMs: [] })).rejects.toThrow('schedule');
  });
});
