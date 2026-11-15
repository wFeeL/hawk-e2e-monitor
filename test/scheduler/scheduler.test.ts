import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';
import { createRedactor } from '../../src/errors/redact.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import type { RunRow } from '../../src/storage/types.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import { createScheduler } from '../../src/scheduler/scheduler.js';
import type { ScenarioRunOptions, Scheduler, SchedulerDeps } from '../../src/scheduler/scheduler.js';

const START = new Date('2026-03-10T12:00:00.000Z');
const INTERVAL_MS = 600_000;
const STAGGER_MS = 30_000;
// RUN 3000 + CLEANUP 600 + grace 30000 of the test configuration.
const WATCHDOG_MS = 33_600;
const CLEANUP_MS = 600;
const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';
const PROBE = 'endpoints-probe';

/** A call of a fake runner. */
interface Call extends ScenarioRunOptions {
  /** Monotonic time of the call. */
  atMs: number;
  /** Ends the run with a result. */
  resolve: (result?: Partial<RunResult>) => void;
  /** Ends the run with an error. */
  reject: (error: unknown) => void;
}

/** A runner that waits for the test to end each of its runs. */
interface FakeRunner {
  /** The runner for `SchedulerDeps`. */
  run: (options: ScenarioRunOptions) => Promise<RunResult>;
  /** Calls so far. */
  calls: Call[];
}

/** A row reported through `onRunFinished`. */
interface FinishedRow {
  /** The row. */
  row: RunRow;
  /** Result handed with it. */
  result: RunResult | undefined;
}

/** Scheduler with its parts. */
interface Setup {
  /** Scheduler under test. */
  scheduler: Scheduler;
  /** History behind it. */
  history: History;
  /** Fake clock. */
  clock: FakeClock;
  /** Log. */
  logger: MemoryLogger;
  /** Rows reported through `onRunFinished`. */
  finished: FinishedRow[];
  /** Fake runners by scenario. */
  runners: Pick<Record<ScenarioName, FakeRunner>, typeof NOTIFY | typeof PROBE | typeof SEND>;
  /** The `exit` spy. */
  exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  /** Configuration used. */
  config: Config;
}

/** What a test may change. */
interface SetupOptions {
  /** Scenarios to run, both by default. */
  scenarios?: ScenarioName[];
  /** Interval between runs of a scenario. */
  intervalMs?: number;
  /** History to use; a fresh one by default. */
  history?: History;
  /** Clock to use. */
  clock?: FakeClock;
  /** Other deps. */
  deps?: Partial<SchedulerDeps>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * Builds a runner whose runs the test ends by hand.
 * @param clock Gives the time of each call.
 * @param scenario Scenario the runner serves.
 * @returns Runner and its calls.
 */
function fakeRunner(clock: FakeClock, scenario: ScenarioName): FakeRunner {
  const calls: Call[] = [];

  return { calls,
    run: async options => new Promise<RunResult>((resolve, reject) => {
      calls.push({ ...options,
        atMs: clock.monotonicMs(),
        resolve: (result = {}) => {
          resolve(runResultFixture({ runId: options.runId,
            sequence: options.sequence,
            scenario,
            ...result }));
        },
        reject });
    }) };
}

/**
 * Builds the scheduler on fake clocks, an in-memory history and fake runners; it is stopped after the test.
 * @param options Differences from the defaults.
 * @returns The scheduler with its parts, not started.
 */
function setup(options: SetupOptions = {}): Setup {
  const clock = options.clock ?? createFakeClock({ wall: START });
  const history = options.history ?? createHistory(openDatabase(':memory:'));
  const logger = memoryLogger();
  const base = testConfig();
  const config: Config = { ...base,
    monitoring: { ...base.monitoring,
      scenarios: options.scenarios ?? [SEND, NOTIFY],
      intervalMs: options.intervalMs ?? INTERVAL_MS,
      staggerMs: STAGGER_MS } };
  const runners = { [SEND]: fakeRunner(clock, SEND),
    [NOTIFY]: fakeRunner(clock, NOTIFY),
    [PROBE]: fakeRunner(clock, PROBE) };
  const finished: FinishedRow[] = [];
  const exit = vi.fn<(code: number) => void>();
  let counter = 0;
  const scheduler = createScheduler({ runners: { [SEND]: runners[SEND].run,
    [NOTIFY]: runners[NOTIFY].run,
    [PROBE]: runners[PROBE].run },
  history,
  clock,
  logger,
  config,
  redact: createRedactor(['hunter2-secret']),
  newRunId: () => {
    counter += 1;

    return `r${String.fromCodePoint(96 + counter).repeat(15)}`;
  },
  onRunFinished: (row, result) => {
    finished.push({ row,
      result });
  },
  exit,
  ...options.deps });

  cleanups.push(async () => {
    await scheduler.stop();
  });

  return { scheduler,
    history,
    clock,
    logger,
    finished,
    runners,
    exit,
    config };
}

/**
 * Takes a call, failing the test when it is missing.
 * @param runner Runner whose calls are read.
 * @param index Position of the call.
 * @returns The call at that position.
 */
function callOf(runner: FakeRunner, index: number): Call {
  const call = runner.calls[index];

  if (call === undefined) {
    throw new Error(`Runner has no call number ${String(index)}`);
  }

  return call;
}

/**
 * Lets the pending promises settle.
 * @param clock Fake clock.
 * @returns Resolves after a macrotask.
 */
async function settle(clock: FakeClock): Promise<void> {
  await clock.advance(0);
}

/**
 * Reads a row, failing the test when it is missing.
 * @param history History to read.
 * @param runId Run to find.
 * @returns The stored row of the run.
 */
function rowOf(history: History, runId: string): RunRow {
  const row = history.get(runId);

  if (row === undefined) {
    throw new Error(`No row for ${runId}`);
  }

  return row;
}

describe('schedule', () => {
  it('starts the first scenario at once and the second after the stagger', async () => {
    const { scheduler, clock, runners } = setup();

    scheduler.start();
    await settle(clock);
    expect(runners[SEND].calls).toHaveLength(1);
    expect(runners[NOTIFY].calls).toHaveLength(0);

    await clock.advance(STAGGER_MS - 1);
    expect(runners[NOTIFY].calls).toHaveLength(0);
    await clock.advance(1);
    expect(runners[NOTIFY].calls).toHaveLength(1);
  });

  it('records the run as running with the id, number and trigger it hands to the runner', async () => {
    const { scheduler, clock, runners, history } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);

    const call = callOf(runners[SEND], 0);

    expect(call).toMatchObject({ runId: 'raaaaaaaaaaaaaaa',
      sequence: 1 });
    expect(rowOf(history, call.runId)).toMatchObject({ status: 'running',
      trigger: 'schedule',
      scenario: SEND,
      startedAt: START.toISOString() });
    expect(scheduler.activeRunIds()).toEqual(new Set(['raaaaaaaaaaaaaaa']));
    expect(scheduler.status()[0]).toMatchObject({ scenario: SEND,
      runningRunId: 'raaaaaaaaaaaaaaa',
      storageFailed: false });
  });

  it('writes the finished run with its stages and reports the row', async () => {
    const { scheduler, clock, runners, history, finished } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve({ eventLatencyMs: 900 });
    await settle(clock);

    expect(rowOf(history, 'raaaaaaaaaaaaaaa')).toMatchObject({ status: 'ok',
      eventLatencyMs: 900,
      degraded: [] });
    expect(rowOf(history, 'raaaaaaaaaaaaaaa').stages).toHaveLength(5);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.row).toMatchObject({ runId: 'raaaaaaaaaaaaaaa',
      status: 'ok' });
    expect(finished[0]?.result?.runId).toBe('raaaaaaaaaaaaaaa');
    expect(scheduler.activeRunIds().size).toBe(0);
  });

  it('starts the next run one interval after the start of the previous one, even when the run was long', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(20_000);
    callOf(runners[SEND], 0).resolve();
    await clock.advance(INTERVAL_MS - 20_001);
    expect(runners[SEND].calls).toHaveLength(1);
    await clock.advance(1);
    expect(runners[SEND].calls).toHaveLength(2);
    expect(callOf(runners[SEND], 1).atMs - callOf(runners[SEND], 0).atMs).toBe(INTERVAL_MS);
  });

  it('numbers runs per scenario, consecutively, and goes on after a new scheduler on the same history', async () => {
    const first = setup();

    first.scheduler.start();
    await settle(first.clock);
    await first.clock.advance(STAGGER_MS);
    callOf(first.runners[SEND], 0).resolve();
    callOf(first.runners[NOTIFY], 0).resolve();
    await first.clock.advance(INTERVAL_MS);
    expect(callOf(first.runners[SEND], 1).sequence).toBe(2);
    expect(callOf(first.runners[NOTIFY], 0).sequence).toBe(1);
    callOf(first.runners[SEND], 1).resolve();
    await settle(first.clock);
    await first.scheduler.stop();
    // Past the interval, so the restart does not wait for the old schedule.
    await first.clock.advance(INTERVAL_MS);

    const second = setup({ history: first.history,
      clock: first.clock,
      scenarios: [SEND] });

    second.scheduler.start();
    await settle(second.clock);
    expect(callOf(second.runners[SEND], 0).sequence).toBe(3);
  });

  it('gives an odd and an even number in a row, so both transports run', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await clock.advance(INTERVAL_MS);

    expect([callOf(runners[SEND], 0).sequence, callOf(runners[SEND], 1).sequence]).toEqual([1, 2]);
  });
});

describe('restart', () => {
  /**
   * Stores a finished run that started some time ago.
   * @param history History to write to.
   * @param runId Id given to the run.
   * @param agoMs Age of the start.
   * @param overlap Store a skipped overlap instead of a run.
   */
  function seed(history: History, runId: string, agoMs: number, overlap = false): void {
    const startedAt = new Date(START.getTime() - agoMs).toISOString();

    if (overlap) {
      history.recordSkip({ runId,
        scenario: SEND,
        sequence: 9,
        trigger: 'schedule',
        at: startedAt,
        reason: 'overlap' });

      return;
    }

    history.startRun({ runId,
      scenario: SEND,
      sequence: 4,
      trigger: 'schedule',
      startedAt });
    history.finishRun(runId, { status: 'ok',
      finishedAt: startedAt,
      durationMs: 1,
      degraded: [] });
  }

  it('waits for the old schedule when the last run is younger than the interval', async () => {
    const history = createHistory(openDatabase(':memory:'));

    seed(history, 'rzzzzzzzzzzzzzzzz', 120_000);

    const { scheduler, clock, runners } = setup({ history,
      scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(INTERVAL_MS - 120_000 - 1);
    expect(runners[SEND].calls).toHaveLength(0);
    await clock.advance(1);
    expect(runners[SEND].calls).toHaveLength(1);
    expect(callOf(runners[SEND], 0).sequence).toBe(5);
  });

  it('ignores a skipped overlap when it looks for the last run', async () => {
    const history = createHistory(openDatabase(':memory:'));

    seed(history, 'rzzzzzzzzzzzzzzzz', 400_000);
    seed(history, 'ryyyyyyyyyyyyyyyy', 10_000, true);

    const { scheduler, clock, runners } = setup({ history,
      scenarios: [SEND] });

    scheduler.start();
    await clock.advance(INTERVAL_MS - 400_000 - 1);
    expect(runners[SEND].calls).toHaveLength(0);
    await clock.advance(1);
    expect(runners[SEND].calls).toHaveLength(1);
  });

  it('starts at once when the last run is older than the interval', async () => {
    const history = createHistory(openDatabase(':memory:'));

    seed(history, 'rzzzzzzzzzzzzzzzz', INTERVAL_MS + 1000);

    const { scheduler, clock, runners } = setup({ history,
      scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    expect(runners[SEND].calls).toHaveLength(1);
  });
});

describe('busy scenario', () => {
  it('a tick during a run is a skipped overlap that takes no number', async () => {
    const { scheduler, clock, runners, history, finished } = setup();

    scheduler.start();
    await settle(clock);

    const started = scheduler.runNow(NOTIFY, 'manual');

    expect(started).toMatchObject({ started: true });
    await clock.advance(STAGGER_MS);
    // The tick of the second scenario found the manual run still going.
    expect(runners[NOTIFY].calls).toHaveLength(1);

    const skipped = history.list({ scenario: NOTIFY,
      limit: 5 }).find(row => row.status === 'skipped');

    expect(skipped).toMatchObject({ skipReason: 'overlap',
      sequence: 2,
      trigger: 'schedule' });
    expect(finished.some(item => item.row.skipReason === 'overlap')).toBe(true);
    expect(history.nextSequence(NOTIFY)).toBe(2);

    // The next tick comes one interval after the skipped one.
    callOf(runners[NOTIFY], 0).resolve();
    await clock.advance(INTERVAL_MS - 1);
    expect(runners[NOTIFY].calls).toHaveLength(1);
    await clock.advance(1);
    expect(runners[NOTIFY].calls).toHaveLength(2);
  });

  it('runNow starts a manual run and resolves with its row, or names the run in the way', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });
    const first = scheduler.runNow(SEND, 'manual');

    if (!first.started) {
      throw new Error('Expected the run to start');
    }

    await settle(clock);
    expect(scheduler.runNow(SEND, 'manual')).toEqual({ started: false,
      runningRunId: first.runId });
    callOf(runners[SEND], 0).resolve();
    expect(await first.done).toMatchObject({ runId: first.runId,
      status: 'ok',
      trigger: 'manual' });
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: true });
  });
});

describe('failures of the runner', () => {
  it('a runner that throws is aborted monitor_internal with a masked text, and the next tick goes on', async () => {
    const { scheduler, clock, runners, history, logger } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).reject(new Error('boom hunter2-secret'));
    await settle(clock);

    const row = rowOf(history, 'raaaaaaaaaaaaaaa');

    expect(row).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_internal',
      culprit: 'monitor' });
    expect(row.message).toContain('scenario threw: boom ***');
    expect(JSON.stringify(logger.lines)).not.toContain('hunter2-secret');
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
    await clock.advance(INTERVAL_MS);
    expect(runners[SEND].calls).toHaveLength(2);
  });

  it('a runner that throws synchronously is handled too', async () => {
    const { scheduler, clock, history } = setup({ scenarios: [SEND],
      deps: { runners: { [SEND]: () => {
        throw new Error('sync boom');
      } } } });

    scheduler.start();
    await settle(clock);
    expect(rowOf(history, 'raaaaaaaaaaaaaaa')).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_internal' });
  });

  it('a run that never ends is aborted run_hung, its signal is aborted and its late failure is harmless', async () => {
    const unhandled = vi.fn();
    const { scheduler, clock, runners, history, logger } = setup({ scenarios: [SEND] });

    process.on('unhandledRejection', unhandled);

    try {
      scheduler.start();
      await settle(clock);

      const call = callOf(runners[SEND], 0);

      await clock.advance(WATCHDOG_MS - 1);
      expect(rowOf(history, call.runId).status).toBe('running');
      expect(call.signal.aborted).toBe(false);
      await clock.advance(1);
      expect(rowOf(history, call.runId)).toMatchObject({ status: 'aborted',
        errorClass: 'run_hung',
        culprit: 'monitor' });
      expect(call.signal.aborted).toBe(true);

      call.reject(new Error('late failure'));
      await settle(clock);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).not.toHaveBeenCalled();
      expect(rowOf(history, call.runId).errorClass).toBe('run_hung');
      expect(logger.lines.some(line => line.level === 'warn' && String(line.msg).includes('abandoned'))).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a late result of an abandoned run changes nothing', async () => {
    const { scheduler, clock, runners, history } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS);
    callOf(runners[SEND], 0).resolve();
    await settle(clock);
    expect(rowOf(history, 'raaaaaaaaaaaaaaa').status).toBe('aborted');
  });

  it('an abandoned run that settles within the cleanup timeout frees the scenario at once', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS);
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: false });
    callOf(runners[SEND], 0).resolve();
    await settle(clock);
    expect(scheduler.activeRunIds().size).toBe(0);
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: true });
    expect(runners[SEND].calls).toHaveLength(2);
  });

  it('an abandoned run that never settles frees the scenario when the cleanup timeout has passed', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS + CLEANUP_MS - 1);
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: false });
    await clock.advance(1);
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: true });
    expect(runners[SEND].calls).toHaveLength(2);
  });

  it('keeps the scenario busy for the cleanup timeout after the abort, then a tick runs again', async () => {
    const { scheduler, clock, runners, history } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS);
    expect(scheduler.activeRunIds()).toEqual(new Set(['raaaaaaaaaaaaaaa']));
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: false });
    await clock.advance(CLEANUP_MS);
    expect(scheduler.activeRunIds().size).toBe(0);
    expect(history.nextSequence(SEND)).toBe(2);
    expect(scheduler.runNow(SEND, 'manual')).toMatchObject({ started: true });
    expect(runners[SEND].calls).toHaveLength(2);
  });

  it('three hung runs of one scenario in a row exit with code 1, not before', async () => {
    const { scheduler, clock, exit } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(INTERVAL_MS + WATCHDOG_MS);
    expect(exit).not.toHaveBeenCalled();
    await clock.advance(INTERVAL_MS);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('good runs of another scenario do not reset the count of a hanging one', async () => {
    const { scheduler, clock, runners, exit } = setup();

    scheduler.start();
    await settle(clock);

    // The notification scenario keeps finishing well, the send scenario hangs.
    for (let round = 0; round < 3; round += 1) {
      await clock.advance(STAGGER_MS);

      const calls = runners[NOTIFY].calls;
      const last = calls.at(-1);

      last?.resolve();
      await settle(clock);
      await clock.advance(INTERVAL_MS - STAGGER_MS);
    }

    expect(runners[NOTIFY].calls.length).toBeGreaterThanOrEqual(3);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('good runs of the probe between three hung runs of another scenario do not reset the count', async () => {
    const { scheduler, clock, runners, exit } = setup({ scenarios: [SEND, PROBE] });
    const STEP_MS = 5000;

    /**
     * Moves the time on and ends the probe run that has started, as a probe that answers at once would.
     * @param ms Time to move on.
     */
    const advance = async (ms: number): Promise<void> => {
      for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
        await clock.advance(STEP_MS);
        runners[PROBE].calls.at(-1)?.resolve();
        await settle(clock);
      }
    };

    scheduler.start();
    await settle(clock);

    // The send scenario hangs at 0 s, 600 s and 1200 s and is abandoned 33.6 s later; the probe is good in between.
    await advance(1200_000);
    expect(exit).not.toHaveBeenCalled();
    await advance(60_000);

    expect(runners[PROBE].calls.length).toBeGreaterThan(12);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a good run of the same scenario resets its count', async () => {
    const { scheduler, clock, runners, exit } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(INTERVAL_MS + WATCHDOG_MS - CLEANUP_MS);
    callOf(runners[SEND], 1).resolve();
    await settle(clock);
    await clock.advance(INTERVAL_MS * 2);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('degradation', () => {
  it('a run whose quota stage found the event limit nearly used is degraded with quota_usage', async () => {
    const { scheduler, clock, runners, finished } = setup();

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve({ stages: [stageFixture('api_availability', 'ok', 5, { details: { quotaLow: true,
      quota: { eventsCount: 950,
        eventsLimit: 1000 } } })] });
    await settle(clock);

    expect(finished[0]?.row.degraded).toEqual(['quota_usage']);
  });
});

describe('warmup', () => {
  /**
   * Builds the result of a run whose notification check was skipped.
   * @param details Extra details of the skipped stage.
   * @returns Result fields for the fake runner.
   */
  function warmupResult(details: Record<string, unknown>): Partial<RunResult> {
    return { scenario: NOTIFY,
      stages: [stageFixture('notification_formed', 'skipped', 0, { details: { reason: 'rule_cache_warmup',
        ...details } })] };
  }

  it('moves the next tick to the end of the warmup plus a second', async () => {
    const { scheduler, clock, runners, history } = setup({ scenarios: [NOTIFY] });

    scheduler.start();
    await settle(clock);
    await clock.advance(5000);
    callOf(runners[NOTIFY], 0).resolve(warmupResult({ warmupRemainingMs: 20_000 }));
    await settle(clock);

    expect(rowOf(history, 'raaaaaaaaaaaaaaa')).toMatchObject({ status: 'skipped',
      skipReason: 'rule_cache_warmup' });
    await clock.advance(20_999);
    expect(runners[NOTIFY].calls).toHaveLength(1);
    await clock.advance(1);
    expect(runners[NOTIFY].calls).toHaveLength(2);
    expect(callOf(runners[NOTIFY], 1).sequence).toBe(2);
  });

  it('falls back to the configured warmup when the stage did not say how long', async () => {
    const { scheduler, clock, runners, config } = setup({ scenarios: [NOTIFY] });
    const wait = config.notifications.ruleCacheWarmupMs + 1000;

    scheduler.start();
    await settle(clock);
    callOf(runners[NOTIFY], 0).resolve(warmupResult({}));
    await settle(clock);
    await clock.advance(wait - 1);
    expect(runners[NOTIFY].calls).toHaveLength(1);
    await clock.advance(1);
    expect(runners[NOTIFY].calls).toHaveLength(2);
  });
});

describe('stop', () => {
  it('records monitor_stopped for running runs, aborts their signal and ignores their late result', async () => {
    const { scheduler, clock, runners, history, finished } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);

    const call = callOf(runners[SEND], 0);

    await scheduler.stop();
    expect(call.signal.aborted).toBe(true);
    expect(rowOf(history, call.runId)).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_stopped' });
    expect(finished.at(-1)?.row.errorClass).toBe('monitor_stopped');

    call.resolve();
    await settle(clock);
    expect(rowOf(history, call.runId).errorClass).toBe('monitor_stopped');
    expect(clock.pending()).toBe(0);
    await clock.advance(INTERVAL_MS * 2);
    expect(runners[SEND].calls).toHaveLength(1);
    await scheduler.stop();
  });

  it('cancels the wait before the first run', async () => {
    let seen: AbortSignal | undefined;
    const { scheduler, clock, runners } = setup({ scenarios: [NOTIFY],
      deps: { beforeFirstRun: { [NOTIFY]: async (signal) => {
        seen = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            resolve();
          });
        });
      } } } });

    scheduler.start();
    await settle(clock);
    await scheduler.stop();
    expect(seen?.aborted).toBe(true);
    await settle(clock);
    expect(runners[NOTIFY].calls).toHaveLength(0);
  });
});

describe('first run gate', () => {
  it('waits for beforeFirstRun, and a rejection is logged and ignored', async () => {
    const { scheduler, clock, runners, logger } = setup({ scenarios: [NOTIFY],
      deps: { beforeFirstRun: { [NOTIFY]: async () => Promise.reject(new Error('tunnel is down')) } } });

    scheduler.start();
    await settle(clock);
    expect(runners[NOTIFY].calls).toHaveLength(1);
    expect(logger.lines.some(line => line.level === 'warn' && String(line.msg).includes('before the first run'))).toBe(true);
  });

  it('does not start until the wait ends', async () => {
    let release: () => void = () => undefined;
    const { scheduler, clock, runners } = setup({ scenarios: [NOTIFY],
      deps: { beforeFirstRun: { [NOTIFY]: async () => new Promise<void>((resolve) => {
        release = resolve;
      }) } } });

    scheduler.start();
    await settle(clock);
    expect(runners[NOTIFY].calls).toHaveLength(0);
    release();
    await settle(clock);
    expect(runners[NOTIFY].calls).toHaveLength(1);
  });
});

describe('health', () => {
  const THRESHOLD_MS = INTERVAL_MS + WATCHDOG_MS;

  it('is false before the start and after the stop', async () => {
    const { scheduler, clock } = setup({ scenarios: [SEND] });

    expect(scheduler.health()).toEqual({ scheduler: false,
      storage: true,
      stuck: [] });
    scheduler.start();
    await settle(clock);
    expect(scheduler.healthy()).toBe(true);
    await scheduler.stop();
    expect(scheduler.health().scheduler).toBe(false);
  });

  it('exits with code 1 when a scenario stopped ticking, but only after the tunnel wait it is given before its first tick', async () => {
    const { scheduler, clock, config, exit, logger } = setup({ scenarios: [NOTIFY],
      deps: { beforeFirstRun: { [NOTIFY]: async () => new Promise<void>(() => undefined) } } });
    const tunnelMs = config.monitoring.tunnelReadyTimeoutMs;

    scheduler.start();
    await settle(clock);
    expect(scheduler.health(THRESHOLD_MS + tunnelMs).scheduler).toBe(true);
    expect(scheduler.health(THRESHOLD_MS + tunnelMs + 1).scheduler).toBe(false);
    // The self-check runs every minute: it must not fire inside the tunnel wait, only after it.
    await clock.advance(THRESHOLD_MS + tunnelMs - 1);
    expect(exit).not.toHaveBeenCalled();
    await clock.advance(60_000);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
  });

  it('reads the threshold of a scenario from intervalOf', async () => {
    const { scheduler, clock } = setup({ scenarios: [SEND],
      deps: { intervalOf: () => 60_000 } });

    scheduler.start();
    await settle(clock);
    expect(scheduler.health(60_000 + WATCHDOG_MS).scheduler).toBe(true);
    expect(scheduler.health(60_000 + WATCHDOG_MS + 1).scheduler).toBe(false);
  });

  it('runs the next tick after the interval that intervalOf gives', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND],
      deps: { intervalOf: () => 60_000 } });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await clock.advance(59_999);
    expect(runners[SEND].calls).toHaveLength(1);
    await clock.advance(1);
    expect(runners[SEND].calls).toHaveLength(2);
  });

  it('does not exit while the scenarios keep ticking', async () => {
    const { scheduler, clock, runners, exit } = setup({ scenarios: [SEND] });

    scheduler.start();

    for (let round = 0; round < 4; round += 1) {
      await settle(clock);
      callOf(runners[SEND], round).resolve();
      await clock.advance(INTERVAL_MS);
    }

    expect(exit).not.toHaveBeenCalled();
    expect(scheduler.healthy()).toBe(true);
  });
});

/** A switch a test flips. */
interface Switch {
  /** True while writes fail. */
  broken: boolean;
}

describe('storage failure', () => {
  /**
   * Wraps a history so that its writes fail while a switch is on.
   * @param history History to wrap.
   * @param control Switch that makes writes fail.
   * @returns The wrapped history.
   */
  function breakable(history: History, control: Switch): History {
    const check = (): void => {
      if (control.broken) {
        throw new Error('disk full');
      }
    };

    return { ...history,
      startRun: (start) => {
        check();
        history.startRun(start);
      },
      finishRun: (runId, outcome) => {
        check();
        history.finishRun(runId, outcome);
      },
      recordSkip: (skip) => {
        check();
        history.recordSkip(skip);
      } };
  }

  it('keeps running, reports an in-memory row and clears the flag after the next good write', async () => {
    const control = { broken: true };
    const real = createHistory(openDatabase(':memory:'));
    const { scheduler, clock, runners, finished, logger } = setup({ scenarios: [SEND],
      history: breakable(real, control) });

    scheduler.start();
    await settle(clock);
    expect(scheduler.health().storage).toBe(false);
    expect(scheduler.status()[0]?.storageFailed).toBe(true);
    callOf(runners[SEND], 0).resolve();
    await settle(clock);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.row).toMatchObject({ id: 0,
      status: 'ok',
      runId: 'raaaaaaaaaaaaaaa' });
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
    expect(scheduler.failures()).toBeGreaterThan(0);
    expect(scheduler.healthy()).toBe(false);

    control.broken = false;
    await clock.advance(INTERVAL_MS);
    expect(scheduler.health().storage).toBe(true);
    callOf(runners[SEND], 1).resolve();
    await settle(clock);
    expect(scheduler.health().storage).toBe(true);
    expect(real.get('rbbbbbbbbbbbbbbb')?.status).toBe('ok');
  });

  it('a failing nextSequence falls back to a counter in memory', async () => {
    const real = createHistory(openDatabase(':memory:'));
    const { scheduler, clock, runners } = setup({ scenarios: [SEND],
      history: { ...real,
        nextSequence: () => {
          throw new Error('locked');
        } } });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await clock.advance(INTERVAL_MS);
    expect([callOf(runners[SEND], 0).sequence, callOf(runners[SEND], 1).sequence]).toEqual([1, 2]);
  });
});

describe('a scenario that stays busy', () => {
  it('is reported as stuck once its run should have been abandoned and released', async () => {
    const { scheduler, clock } = setup({ scenarios: [SEND, NOTIFY] });

    scheduler.start();
    await settle(clock);

    const limit = WATCHDOG_MS + CLEANUP_MS;
    const now = clock.monotonicMs();

    expect(scheduler.health(now + limit).stuck).toEqual([]);
    expect(scheduler.health(now + limit + 1).stuck).toEqual([SEND]);
    expect(scheduler.healthy(now + limit + 1)).toBe(false);
  });

  it('is not stuck while an abandoned run is held for its cleanup', async () => {
    const { scheduler, clock } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS);
    expect(scheduler.activeRunIds().size).toBe(1);
    expect(scheduler.health().stuck).toEqual([]);
  });
});

describe('sequence while the history cannot be written', () => {
  it('keeps counting runs when startRun fails, so the transport still alternates', async () => {
    const control = { broken: true };
    const real = createHistory(openDatabase(':memory:'));
    const { scheduler, clock, runners } = setup({ scenarios: [SEND],
      history: { ...real,
        startRun: (start) => {
          if (control.broken) {
            throw new Error('disk full');
          }

          real.startRun(start);
        } } });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await clock.advance(INTERVAL_MS);
    callOf(runners[SEND], 1).resolve();
    await clock.advance(INTERVAL_MS);
    expect([0, 1, 2].map(index => callOf(runners[SEND], index).sequence)).toEqual([1, 2, 3]);
    control.broken = false;
    callOf(runners[SEND], 2).resolve();
    await clock.advance(INTERVAL_MS);
    expect(callOf(runners[SEND], 3).sequence).toBe(4);
    callOf(runners[SEND], 3).resolve();
    await clock.advance(INTERVAL_MS);
    expect(callOf(runners[SEND], 4).sequence).toBe(5);
  });
});

describe('subscribers', () => {
  it('calls every subscriber in its own try, and an error of one does not stop the others', async () => {
    const seen: string[] = [];
    const { scheduler, clock, runners, logger } = setup({ scenarios: [SEND],
      deps: { onRunFinished: [() => {
        throw new Error('first listener broke');
      }, (row) => {
        seen.push(row.runId);
      }] } });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await settle(clock);

    expect(seen).toEqual(['raaaaaaaaaaaaaaa']);
    expect(logger.lines.some(line => line.level === 'error' && String(line.msg).includes('listener'))).toBe(true);
  });
});

describe('lastVerdictAt', () => {
  const FINISHED_MS = Date.parse('2026-03-10T10:00:05.000Z');

  it('is unknown before a run with a verdict has ended', async () => {
    const { scheduler, clock } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);

    expect(scheduler.lastVerdictAt(SEND)).toBeUndefined();
    expect(scheduler.lastVerdictAt(NOTIFY)).toBeUndefined();
  });

  it('is the end of the last ok or failed run', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    callOf(runners[SEND], 0).resolve();
    await settle(clock);
    expect(scheduler.lastVerdictAt(SEND)).toBe(FINISHED_MS);

    await clock.advance(INTERVAL_MS);
    callOf(runners[SEND], 1).resolve({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk',
      finishedAt: '2026-03-10T10:10:05.000Z' });
    await settle(clock);
    expect(scheduler.lastVerdictAt(SEND)).toBe(FINISHED_MS + INTERVAL_MS);
  });

  it('does not count a hung run or an overlap skip', async () => {
    const { scheduler, clock, history } = setup({ scenarios: [SEND] });

    scheduler.start();
    await settle(clock);
    await clock.advance(WATCHDOG_MS + 1);
    expect(history.list({ scenario: SEND,
      limit: 5 })[0]).toMatchObject({ status: 'aborted',
      errorClass: 'run_hung' });
    expect(scheduler.lastVerdictAt(SEND)).toBeUndefined();
  });

  it('counts a warmup skip as a verdict', async () => {
    const { scheduler, clock, runners } = setup({ scenarios: [NOTIFY] });

    scheduler.start();
    await settle(clock);
    callOf(runners[NOTIFY], 0).resolve({ scenario: NOTIFY,
      stages: [stageFixture('notification_formed', 'skipped', 0, { details: { reason: 'rule_cache_warmup' } })] });
    await settle(clock);

    expect(scheduler.lastVerdictAt(NOTIFY)).toBe(FINISHED_MS);
  });

  it('starts from the history of an earlier process, ignoring aborts and overlaps', () => {
    const history = createHistory(openDatabase(':memory:'));
    const ok = '2026-03-10T09:00:00.000Z';

    history.startRun({ runId: 'rbbbbbbbbbbbbbbbb',
      scenario: SEND,
      sequence: 1,
      trigger: 'schedule',
      startedAt: ok });
    history.finishRun('rbbbbbbbbbbbbbbbb', { status: 'ok',
      finishedAt: '2026-03-10T09:00:05.000Z',
      durationMs: 5000,
      degraded: [] });
    history.startRun({ runId: 'rcccccccccccccccc',
      scenario: SEND,
      sequence: 2,
      trigger: 'schedule',
      startedAt: '2026-03-10T09:10:00.000Z' });
    history.finishRun('rcccccccccccccccc', { status: 'aborted',
      finishedAt: '2026-03-10T09:20:00.000Z',
      durationMs: 1,
      degraded: [],
      errorClass: 'run_hung',
      culprit: 'monitor' });

    const { scheduler } = setup({ scenarios: [SEND],
      history });

    expect(scheduler.lastVerdictAt(SEND)).toBeUndefined();
    scheduler.start();
    expect(scheduler.lastVerdictAt(SEND)).toBe(Date.parse('2026-03-10T09:00:05.000Z'));
  });

  it('logs and goes on when the history cannot be read at the start', async () => {
    const history = createHistory(openDatabase(':memory:'));
    const { scheduler, clock, logger } = setup({ scenarios: [SEND],
      history });

    history.lastVerdict = () => {
      throw new Error('disk gone');
    };
    scheduler.start();
    await settle(clock);

    expect(scheduler.lastVerdictAt(SEND)).toBeUndefined();
    expect(logger.lines.some(line => line.level === 'error' && String(line.msg).includes('lastVerdict'))).toBe(true);
  });
});
