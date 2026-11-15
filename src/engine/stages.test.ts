import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { CheckError } from '../errors/taxonomy.js';
import { createFakeClock } from '../test-support/fake-clock.js';
import { RUN_CANCELLED, runStage, runStageGroup, skippedStage } from './stages.js';
import type { StageOutcome, StageSpec } from './stages.js';

const neverAbort = (): AbortSignal => new AbortController().signal;
const never = (): Promise<StageOutcome> => new Promise<StageOutcome>(() => undefined);
const realTick = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

describe('runStage', () => {
  it('ok stage records duration', async () => {
    const clock = createFakeClock();
    const spec: StageSpec<undefined> = { name: 'api_availability',
      timeoutMs: 1000,
      run: async () => {
        await clock.sleep(250);

        return { status: 'ok',
          details: { warning: 'low quota' } };
      } };
    const running = runStage(spec, undefined, { clock,
      runSignal: neverAbort() });

    await clock.advance(250);

    expect(await running).toEqual({ name: 'api_availability',
      status: 'ok',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 250,
      details: { warning: 'low quota' } });
    expect(clock.pending()).toBe(0);
  });

  it('failed CheckError keeps class and culprit', async () => {
    const clock = createFakeClock();
    const error = new CheckError('quota_exhausted', { detail: '10/10' });
    const result = await runStage({ name: 'api_availability',
      timeoutMs: 1000,
      run: () => Promise.resolve({ status: 'failed',
        error }) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor',
      message: error.message });
  });

  it('uncertain keeps the cause class', async () => {
    const clock = createFakeClock();
    const result = await runStage({ name: 'collector_accept',
      timeoutMs: 1000,
      run: () => Promise.resolve({ status: 'uncertain',
        error: new CheckError('collector_unavailable', { code: 'TIMEOUT' }) }) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(result).toMatchObject({ status: 'uncertain',
      errorClass: 'collector_unavailable',
      culprit: 'hawk' });
  });

  it('failed without an error is monitor_internal', async () => {
    const clock = createFakeClock();
    const result = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => Promise.resolve({ status: 'failed' }) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(result.errorClass).toBe('monitor_internal');
    expect(result.message).toContain('stage failed without an error');
  });

  it('skipped from run is recorded as is', async () => {
    const clock = createFakeClock();
    const result = await runStage({ name: 'event_repeated',
      timeoutMs: 1000,
      run: () => Promise.resolve({ status: 'skipped' }) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(result.status).toBe('skipped');
    expect(result.errorClass).toBeUndefined();
  });

  it('throwing non-CheckError is monitor_internal', async () => {
    const clock = createFakeClock();
    const thrown = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => Promise.reject(new Error('boom')) }, undefined, { clock,
      runSignal: neverAbort() });
    const sync = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => {
        throw new TypeError('sync boom');
      } }, undefined, { clock,
      runSignal: neverAbort() });
    const stringy = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => Promise.reject(new Error('unused')).catch(() => Promise.reject('plain text')) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(thrown).toMatchObject({ status: 'failed',
      errorClass: 'monitor_internal',
      culprit: 'monitor' });
    expect(thrown.message).toContain('boom');
    expect(sync.message).toContain('sync boom');
    expect(stringy.message).toContain('plain');
  });

  it('a thrown CheckError keeps its class', async () => {
    const clock = createFakeClock();
    const result = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => Promise.reject(new CheckError('api_forbidden')) }, undefined, { clock,
      runSignal: neverAbort() });

    expect(result.errorClass).toBe('api_forbidden');
  });

  it.each([
    ['in two steps', [1000, 500]],
    ['in one step', [1500]],
  ] as const)('stage ignoring abort becomes monitor_internal after grace, %s', async (_name, steps) => {
    const clock = createFakeClock();
    const running = runStage({ name: 'event_visible',
      timeoutMs: 1000,
      run: never }, undefined, { clock,
      runSignal: neverAbort(),
      graceMs: 500 });

    for (const step of steps) {
      await clock.advance(step);
    }

    const result = await running;

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'monitor_internal',
      durationMs: 1500 });
    expect(result.message).toContain('stage did not finish after its deadline');
    expect(clock.pending()).toBe(0);
  });

  it('a stage that honors the timeout abort keeps its own result', async () => {
    const clock = createFakeClock();
    const running = runStage({ name: 'event_visible',
      timeoutMs: 1000,
      run: (_context, signal) => new Promise<StageOutcome>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ status: 'failed',
            error: new CheckError('event_not_found') });
        });
      }) }, undefined, { clock,
      runSignal: neverAbort() });

    await clock.advance(1000);

    expect(await running).toMatchObject({ errorClass: 'event_not_found',
      durationMs: 1000 });
  });

  it('run signal abort becomes run_timeout', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const ignoring = runStage({ name: 'event_visible',
      timeoutMs: 100_000,
      run: never }, undefined, { clock,
      runSignal: controller.signal,
      graceMs: 500 });
    const honoring = runStage({ name: 'event_visible',
      timeoutMs: 100_000,
      run: (_context, signal) => new Promise<StageOutcome>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ status: 'failed',
            error: new CheckError('collector_unavailable', { code: 'TIMEOUT' }) });
        });
      }) }, undefined, { clock,
      runSignal: controller.signal });

    await clock.advance(200);
    controller.abort();
    await clock.advance(500);

    expect((await ignoring).errorClass).toBe('run_timeout');
    expect((await honoring).errorClass).toBe('run_timeout');
    expect(clock.pending()).toBe(0);
  });

  it('a run aborted with RUN_CANCELLED says it was cancelled', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const running = runStage({ name: 'event_visible',
      timeoutMs: 100_000,
      run: never }, undefined, { clock,
      runSignal: controller.signal,
      graceMs: 500 });

    controller.abort(RUN_CANCELLED);
    await clock.advance(500);

    expect(await running).toMatchObject({ errorClass: 'run_timeout',
      message: 'The run was cancelled' });
  });

  it('a stage that throws after the run deadline is run_timeout, not the thrown class', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const running = runStage({ name: 'api_availability',
      timeoutMs: 100_000,
      run: (_context, signal) => new Promise<StageOutcome>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new CheckError('api_unavailable', { code: 'TIMEOUT' }));
        });
      }) }, undefined, { clock,
      runSignal: controller.signal });

    await clock.advance(200);
    controller.abort();
    await clock.advance(0);

    expect(await running).toMatchObject({ status: 'failed',
      errorClass: 'run_timeout',
      culprit: 'monitor' });
  });

  it('a stage that throws after its own timeout keeps the thrown class', async () => {
    const clock = createFakeClock();
    const running = runStage({ name: 'api_availability',
      timeoutMs: 1000,
      run: (_context, signal) => new Promise<StageOutcome>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new CheckError('api_unavailable', { code: 'TIMEOUT' }));
        });
      }) }, undefined, { clock,
      runSignal: neverAbort() });

    await clock.advance(1000);

    expect(await running).toMatchObject({ status: 'failed',
      errorClass: 'api_unavailable',
      culprit: 'hawk' });
  });

  it('a run signal aborted on entry aborts the stage', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();

    controller.abort();
    const running = runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: (_context, signal) => Promise.resolve({ status: signal.aborted ? 'failed' : 'ok',
        error: new CheckError('api_unavailable') }) }, undefined, { clock,
      runSignal: controller.signal });

    await clock.advance(0);

    expect((await running).errorClass).toBe('run_timeout');
  });

  it('a finished stage is not changed by a later run abort', async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const result = await runStage({ name: 'cleanup',
      timeoutMs: 1000,
      run: () => Promise.resolve({ status: 'ok' }) }, undefined, { clock,
      runSignal: controller.signal });

    controller.abort();

    expect(result.status).toBe('ok');
  });

  it('late rejection after deadline does not reach unhandledRejection', async () => {
    const clock = createFakeClock();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason);
    };
    let rejectLate: (reason: unknown) => void = () => undefined;

    process.on('unhandledRejection', onUnhandled);

    try {
      const running = runStage({ name: 'event_visible',
        timeoutMs: 100,
        run: () => new Promise<StageOutcome>((_resolve, reject) => {
          rejectLate = reject;
        }) }, undefined, { clock,
        runSignal: neverAbort(),
        graceMs: 100 });

      await clock.advance(200);

      expect((await running).errorClass).toBe('monitor_internal');
      rejectLate(new Error('too late'));
      await realTick();
      await realTick();

      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('runStageGroup', () => {
  it('group runs in parallel and keeps order', async () => {
    const clock = createFakeClock();
    const sleeper = (name: 'event_visible' | 'event_repeated', ms: number): StageSpec<undefined> => ({ name,
      timeoutMs: 10_000,
      run: async () => {
        await clock.sleep(ms);

        return name === 'event_visible'
          ? { status: 'ok' }
          : { status: 'failed',
              error: new CheckError('repeat_not_counted') };
      } });
    const running = runStageGroup([sleeper('event_visible', 100), sleeper('event_repeated', 50)], undefined, { clock,
      runSignal: neverAbort() });

    await clock.advance(100);
    const results = await running;

    expect(results.map(result => result.name)).toEqual(['event_visible', 'event_repeated']);
    expect(results.map(result => result.durationMs)).toEqual([100, 50]);
    expect(results.map(result => result.status)).toEqual(['ok', 'failed']);
  });
});

describe('skippedStage', () => {
  it('has no duration and no message', () => {
    expect(skippedStage('event_repeated', createFakeClock())).toEqual({ name: 'event_repeated',
      status: 'skipped',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0 });
  });
});
