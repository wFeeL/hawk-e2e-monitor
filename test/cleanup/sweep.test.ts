import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HawkApi } from '../../src/clients/hawk-api.js';
import type { Config } from '../../src/config/load.js';
import { runResultFixture } from '../support/run-result.js';
import { buildTitle } from '../../src/scenarios/send-and-receive/plan.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';
import { createTestDeps } from '../support/scenario.js';
import { systemClock } from '../../src/time/clock.js';
import { createSweeper } from '../../src/cleanup/sweep.js';
import type { Sweeper } from '../../src/cleanup/sweep.js';

const INSTANCE = 'fake';
const HOUR_MS = 3_600_000;
const SIGNAL = new AbortController().signal;

let hawk: FakeHawk;
let history: History;
let logger: MemoryLogger;
let config: Config;
let api: HawkApi;
let active: Set<string>;

beforeEach(async () => {
  hawk = await startFakeHawk();
  history = createHistory(openDatabase(':memory:'));
  logger = memoryLogger();
  active = new Set();

  const { deps } = createTestDeps(hawk);

  config = deps.config;
  api = deps.api;
});

afterEach(async () => {
  history.close();
  await hawk.close();
});

/**
 * Builds a sweeper on the fake Hawk.
 * @param overrides Dependencies that replace the defaults of the test.
 * @returns A sweeper that is not started.
 */
function sweeper(overrides: Partial<Parameters<typeof createSweeper>[0]> = {}): Sweeper {
  return createSweeper({ api,
    history,
    clock: systemClock,
    logger,
    config,
    activeRunIds: () => active,
    ...overrides });
}

/** How a stored event differs from one that this instance left. */
interface LeftoverOptions {
  /** Scenario in the title. */
  scenario?: ScenarioName;
  /** Instance id in the context. */
  instanceId?: string;
  /** Title that replaces the generated one. */
  title?: string;
  /** Age of the event in Hawk. */
  ageMs?: number;
}

/**
 * Stores a test event of the monitor in the fake Hawk.
 * @param runId Run the event belongs to.
 * @param options Differences from an event of this instance.
 * @returns Id of the event.
 */
function leftover(runId: string, options: LeftoverOptions = {}): string {
  const instanceId = options.instanceId ?? INSTANCE;
  const stored = hawk.store.ingest(hawk.projectId, 'errors/nodejs', { title: options.title ?? buildTitle(INSTANCE, runId, options.scenario ?? 'send-and-receive-event'),
    context: { runId,
      instanceId } });

  hawk.store.setTimestamp(hawk.projectId, stored.id, Math.floor((Date.now() - (options.ageMs ?? 2 * HOUR_MS)) / 1000));

  return stored.id;
}

/**
 * Stores a run that ended some time ago.
 * @param runId Id given to the run.
 * @param status How it ended.
 * @param agoMs How long ago it ended.
 * @param withEvent Whether its result has the found event.
 */
function finished(runId: string, status: 'failed' | 'ok', agoMs: number, withEvent = true): void {
  const endedAt = new Date(Date.now() - agoMs).toISOString();
  const startedAt = new Date(Date.now() - agoMs - 60_000).toISOString();

  history.startRun({ runId,
    scenario: 'send-and-receive-event',
    sequence: 1,
    trigger: 'schedule',
    startedAt });
  history.finishRun(runId, { status,
    finishedAt: endedAt,
    durationMs: 60_000,
    degraded: [],
    result: runResultFixture({ runId,
      status,
      startedAt,
      finishedAt: endedAt,
      ...withEvent
        ? { event: { originalEventId: 'x',
            groupHash: 'y',
            totalCount: 1 } }
        : {} }) });
}

/**
 * Makes a run id of sixteen letters.
 * @param index Number to put into it.
 * @returns Id like `raaaaaaaaaaaaaab`.
 */
function runIdOf(index: number): string {
  const letters = index.toString(26).split('')
    .map(digit => String.fromCodePoint(97 + Number.parseInt(digit, 26)))
    .join('');

  return `r${letters.padStart(15, 'a')}`;
}

describe('sweepOnce', () => {
  it('removes the event of a run that ended long ago and reports it', async () => {
    const id = leftover('raaaaaaaaaaaaaaa');

    finished('raaaaaaaaaaaaaaa', 'ok', 2 * HOUR_MS);

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toEqual({ scanned: 1,
      removed: 1,
      skipped: 0,
      lateMarked: 0,
      pages: 1 });
    expect(hawk.store.get(hawk.projectId, id)).toBeUndefined();
  });

  it('leaves the events of an instance whose id contains ours', async () => {
    const id = leftover('rbbbbbbbbbbbbbbb', { title: buildTitle('stand-compose', 'rbbbbbbbbbbbbbbb', 'send-and-receive-event') });

    finished('rbbbbbbbbbbbbbbb', 'ok', 2 * HOUR_MS);

    const report = await sweeper({ config: { ...config,
      instanceId: 'stand' } }).sweepOnce(SIGNAL);

    expect(report.error).toBeUndefined();
    expect(report.removed).toBe(0);
    expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
  });

  it('removes the event of a check-notification run as well', async () => {
    const id = leftover('rbbbbbbbbbbbbbbb', { scenario: 'check-notification' });

    finished('rbbbbbbbbbbbbbbb', 'ok', 2 * HOUR_MS);
    await sweeper().sweepOnce(SIGNAL);
    expect(hawk.store.get(hawk.projectId, id)).toBeUndefined();
  });

  it('leaves the event of a run that is going', async () => {
    const id = leftover('rccccccccccccccc');

    history.startRun({ runId: 'rccccccccccccccc',
      scenario: 'send-and-receive-event',
      sequence: 1,
      trigger: 'schedule',
      startedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() });
    active.add('rccccccccccccccc');

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ removed: 0,
      skipped: 1 });
    expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
  });

  it('leaves the event of a run in the history that is still marked running but is not active', async () => {
    const id = leftover('rddddddddddddddd');

    history.startRun({ runId: 'rddddddddddddddd',
      scenario: 'send-and-receive-event',
      sequence: 1,
      trigger: 'schedule',
      startedAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() });
    await sweeper().sweepOnce(SIGNAL);
    expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
  });

  it('leaves the event of a run that ended less than SWEEP_MIN_AGE_MS ago', async () => {
    const id = leftover('reeeeeeeeeeeeeee');

    finished('reeeeeeeeeeeeeee', 'ok', config.monitoring.sweepMinAgeMs - 60_000);
    await sweeper().sweepOnce(SIGNAL);
    expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
  });

  it('leaves an event of another instance, one with a similar title and one with a foreign context', async () => {
    const other = leftover('rfffffffffffffff', { instanceId: 'other' });
    const similar = leftover('rggggggggggggggg', { title: `[e2e:${INSTANCE}] rggggggggggggggg send-and-receive-event and more` });
    const short = leftover('rhhhhhhhhhhhhhhh', { title: `[e2e:${INSTANCE}] rhhh send-and-receive-event` });
    const prefixed = leftover('riiiiiiiiiiiiiii', { title: `see [e2e:${INSTANCE}] riiiiiiiiiiiiiii send-and-receive-event` });

    hawk.api.knobs.foreignEvent = true;
    for (const runId of ['rfffffffffffffff', 'rggggggggggggggg', 'rhhhhhhhhhhhhhhh', 'riiiiiiiiiiiiiii']) {
      finished(runId, 'ok', 2 * HOUR_MS);
    }

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report.removed).toBe(0);
    for (const id of [other, similar, short, prefixed]) {
      expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
    }
  });

  it('removes an event of an unknown run only when Hawk dates it older than SWEEP_MIN_AGE_MS', async () => {
    const old = leftover('rjjjjjjjjjjjjjjj', { ageMs: config.monitoring.sweepMinAgeMs + 60_000 });
    const young = leftover('rkkkkkkkkkkkkkkk', { ageMs: config.monitoring.sweepMinAgeMs - 60_000 });

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ scanned: 2,
      removed: 1,
      skipped: 1 });
    expect(hawk.store.get(hawk.projectId, old)).toBeUndefined();
    expect(hawk.store.get(hawk.projectId, young)).toBeDefined();
  });

  it('marks the late event of a failed run that had not found it, once', async () => {
    leftover('rlllllllllllllll');
    finished('rlllllllllllllll', 'failed', 2 * HOUR_MS, false);

    const report = await sweeper().sweepOnce(SIGNAL);
    const row = history.get('rlllllllllllllll');

    expect(report).toMatchObject({ removed: 1,
      lateMarked: 1 });
    expect(row?.lateEventFoundAt).toBeDefined();
    // From the start of the run, which was an hour and a bit before the pass.
    expect(row?.lateEventDelayMs).toBeGreaterThan(2 * HOUR_MS);
    expect(row?.lateEventDelayMs).toBeLessThan(2 * HOUR_MS + 5 * 60_000);
  });

  it('does not mark a failed run that had found its event, or an ok run', async () => {
    leftover('rmmmmmmmmmmmmmmm');
    leftover('rnnnnnnnnnnnnnnn');
    finished('rmmmmmmmmmmmmmmm', 'failed', 2 * HOUR_MS, true);
    finished('rnnnnnnnnnnnnnnn', 'ok', 2 * HOUR_MS, false);

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ removed: 2,
      lateMarked: 0 });
  });

  it('goes to a second page when the first one is full and something was removed', async () => {
    for (let index = 0; index < 60; index += 1) {
      leftover(runIdOf(index));
    }

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ scanned: 60,
      removed: 60,
      pages: 2 });
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('stops when a full page had nothing to remove', async () => {
    for (let index = 0; index < 55; index += 1) {
      leftover(runIdOf(index), { ageMs: 1000 });
    }

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ scanned: 50,
      removed: 0,
      pages: 1 });
  });

  it('reads at most 10 pages in one pass', async () => {
    for (let index = 0; index < 520; index += 1) {
      leftover(runIdOf(index));
    }

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ pages: 10,
      removed: 500 });
    expect(hawk.store.all(hawk.projectId)).toHaveLength(20);
  });

  it('reports a failure of the API and does not throw', async () => {
    leftover('rooooooooooooooo');
    hawk.api.knobs.errors = Object.fromEntries([['FindEvents', { code: 'INTERNAL_SERVER_ERROR',
      message: 'search is down' }]]);

    const instance = sweeper();
    const report = await instance.sweepOnce(SIGNAL);

    expect(report.error).toContain('search is down');
    expect(report.removed).toBe(0);
    expect(instance.failures()).toBe(1);
    expect(logger.lines.some(line => line.level === 'warn' && line.msg === 'sweep failed')).toBe(true);
  });

  it('reports a failed removal and keeps what it did before', async () => {
    leftover('rppppppppppppppp');
    hawk.api.knobs.rejectRemove = 'error';

    const instance = sweeper();
    const report = await instance.sweepOnce(SIGNAL);

    expect(report.error).toBeDefined();
    expect(instance.failures()).toBe(1);
  });

  it('a pass that ends cleanly does not count as a failure', async () => {
    const instance = sweeper();

    await instance.sweepOnce(SIGNAL);
    expect(instance.failures()).toBe(0);
  });

  it('stops at the signal', async () => {
    leftover('rqqqqqqqqqqqqqqq');

    const controller = new AbortController();

    controller.abort();

    const report = await sweeper().sweepOnce(controller.signal);

    expect(report.error).toBeDefined();
    expect(report.removed).toBe(0);
  });
});

/** A sweeper on a fake clock whose searches are counted. */
interface Counting {
  /** The sweeper. */
  instance: Sweeper;
  /** Its clock. */
  clock: ReturnType<typeof createFakeClock>;
  /** Counts the searches made. */
  searches: () => number;
}

describe('the timer', () => {
  /**
   * Builds a sweeper whose API only counts searches, on a fake clock.
   * @param sweepIntervalMs Interval of the passes.
   * @returns Sweeper, clock and the number of searches.
   */
  function counting(sweepIntervalMs: number): Counting {
    let searches = 0;
    const clock = createFakeClock();
    const counter = { findEvents: () => {
      searches += 1;

      return Promise.resolve([]);
    } } as unknown as HawkApi;
    const base = testConfig();
    const instance = createSweeper({ api: counter,
      history,
      clock,
      logger,
      config: { ...base,
        monitoring: { ...base.monitoring,
          sweepIntervalMs } },
      activeRunIds: () => active });

    return { instance,
      clock,
      searches: () => searches };
  }

  it('first passes after five minutes, then every interval, and stops', async () => {
    const { instance, clock, searches } = counting(HOUR_MS);

    instance.start();
    await clock.advance(5 * 60_000 - 1);
    expect(searches()).toBe(0);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(searches()).toBe(1);
    });
    await clock.advance(HOUR_MS - 1);
    expect(searches()).toBe(1);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(searches()).toBe(2);
    });

    await instance.stop();
    expect(clock.pending()).toBe(0);
    await clock.advance(HOUR_MS * 2);
    expect(searches()).toBe(2);
  });

  it('does nothing when the interval is 0', async () => {
    const { instance, clock, searches } = counting(0);

    instance.start();
    expect(clock.pending()).toBe(0);
    await clock.advance(HOUR_MS * 3);
    expect(searches()).toBe(0);
    await instance.stop();
  });
});
