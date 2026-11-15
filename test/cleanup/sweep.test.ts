import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HawkApi } from '../../src/clients/hawk-api.js';
import type { Config } from '../../src/config/load.js';
import { runResultFixture } from '../support/run-result.js';
import { buildTitle } from '../../src/scenarios/send-and-receive/plan.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
import { openDatabase } from '../../src/storage/database.js';
import { createdProjects } from '../../src/storage/created-projects.js';
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

  it('sweeps an instance whose id has a hyphen, which Hawk would reject as a bracketed pattern', async () => {
    const instanceId = 'stand-compose';
    const id = leftover('raaaaaaaaaaaaaaa', { instanceId,
      title: buildTitle(instanceId, 'raaaaaaaaaaaaaaa', 'send-and-receive-event') });

    finished('raaaaaaaaaaaaaaa', 'ok', 2 * HOUR_MS);

    const report = await sweeper({ config: { ...config,
      instanceId } }).sweepOnce(SIGNAL);

    expect(report.error).toBeUndefined();
    expect(report.removed).toBe(1);
    expect(hawk.store.get(hawk.projectId, id)).toBeUndefined();
  });

  it('leaves the events of an instance whose id contains ours', async () => {
    const id = leftover('rbbbbbbbbbbbbbbb', { instanceId: 'stand-compose',
      title: buildTitle('stand-compose', 'rbbbbbbbbbbbbbbb', 'send-and-receive-event') });

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
    hawk.api.knobs.errors = Object.fromEntries([['ProjectDailyEvents', { code: 'INTERNAL_SERVER_ERROR',
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

const PROJECT_RUN = 'raaaaaaaaaaaaaaa';

/** How a project in the fake Hawk differs from one that `new-project` left. */
interface ProjectOptions {
  /** Workspace that holds it, the one of the monitored project by default. */
  workspaceId?: string;
  /** Name that replaces the generated one. */
  name?: string;
  /** Age in Hawk. */
  ageMs?: number;
  /** Whether the monitor recorded the id, as `new-project` does. */
  recorded?: boolean;
}

/**
 * Puts a project of `new-project` into the fake Hawk.
 * @param runId Run the project belongs to.
 * @param options Differences from a leftover project.
 * @returns Id of the project.
 */
function leftoverProject(runId: string, options: ProjectOptions = {}): string {
  const id = `${runId.slice(1, 9)}${'0'.repeat(16)}`.slice(0, 24).replaceAll(/[^0-9a-f]/gu, 'a');
  const project = hawk.projects.add({ id,
    name: options.name ?? `[e2e:${INSTANCE}] new-project ${runId}`,
    workspaceId: options.workspaceId ?? 'fake-workspace',
    token: `token-${runId}`,
    creationDate: Date.now() - (options.ageMs ?? 2 * HOUR_MS) });

  if (options.recorded !== false) {
    createdProjects(history).record(project.id);
  }

  return project.id;
}

/**
 * Stores an event that came through the Sentry path: the title has the type of the exception in front, the context is under `e2e`.
 * @param runId Run the event belongs to.
 * @param options Differences from an event of this instance.
 * @returns Id of the event.
 */
function sentryLeftover(runId: string, options: LeftoverOptions = {}): string {
  const instanceId = options.instanceId ?? INSTANCE;
  const stored = hawk.store.ingest(hawk.projectId, 'errors/default', { title: options.title ?? `E2eMonitorCheck: ${buildTitle(INSTANCE, runId, 'sentry-envelope')}`,
    context: { e2e: { runId,
      instanceId,
      scenario: 'sentry-envelope' } } });

  hawk.store.setTimestamp(hawk.projectId, stored.id, Math.floor((Date.now() - (options.ageMs ?? 2 * HOUR_MS)) / 1000));

  return stored.id;
}

describe('sweepOnce of events from the Sentry path', () => {
  it('removes the event of a finished run in the second form of the title', async () => {
    const id = sentryLeftover('raaaaaaaaaaaaaaa');

    finished('raaaaaaaaaaaaaaa', 'ok', 2 * HOUR_MS);

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report).toMatchObject({ scanned: 1,
      removed: 1 });
    expect(hawk.store.get(hawk.projectId, id)).toBeUndefined();
  });

  it('removes it when the monitor has no record of the run, once the event is old enough', async () => {
    const id = sentryLeftover('raaaaaaaaaaaaaaa');

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.store.get(hawk.projectId, id)).toBeUndefined();
  });

  it('leaves a young event and an event of a run that is going', async () => {
    const young = sentryLeftover('raaaaaaaaaaaaaaa', { ageMs: 60_000 });
    const going = sentryLeftover('rbbbbbbbbbbbbbbb');

    active.add('rbbbbbbbbbbbbbbb');
    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.store.get(hawk.projectId, young)).toBeDefined();
    expect(hawk.store.get(hawk.projectId, going)).toBeDefined();
  });

  it.each([
    ['another instance in the context', { instanceId: 'other' }],
    ['a title with another prefix', { title: `Other: ${buildTitle(INSTANCE, 'raaaaaaaaaaaaaaa', 'sentry-envelope')}` }],
    ['a title with a prefix and another scenario', { title: `E2eMonitorCheck: ${buildTitle(INSTANCE, 'raaaaaaaaaaaaaaa', 'sourcemaps')}x` }],
    ['text after the title', { title: `E2eMonitorCheck: ${buildTitle(INSTANCE, 'raaaaaaaaaaaaaaa', 'sentry-envelope')} and more` }],
  ])('does not touch an event with %s', async (_name, options) => {
    const id = sentryLeftover('raaaaaaaaaaaaaaa', options);

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.store.get(hawk.projectId, id)).toBeDefined();
  });

  it('does not take the plain context of another scenario for the Sentry one', async () => {
    const stored = hawk.store.ingest(hawk.projectId, 'errors/default', { title: `E2eMonitorCheck: ${buildTitle(INSTANCE, 'raaaaaaaaaaaaaaa', 'sentry-envelope')}`,
      context: { instanceId: 'other',
        runId: 'raaaaaaaaaaaaaaa' } });

    hawk.store.setTimestamp(hawk.projectId, stored.id, Math.floor((Date.now() - 2 * HOUR_MS) / 1000));
    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.store.get(hawk.projectId, stored.id)).toBeDefined();
  });
});

describe('sweepOnce of projects', () => {
  it('removes a recorded project of this instance that is old enough, and forgets it', async () => {
    const id = leftoverProject(PROJECT_RUN);
    const report = await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(false);
    expect(report.projects).toEqual({ removed: 1,
      gone: 0,
      skipped: 0 });
    expect(createdProjects(history).ids()).toEqual([]);
  });

  it('does nothing about projects while the record is empty', async () => {
    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report.projects).toBeUndefined();
    expect(hawk.api.operations).not.toContain('WorkspaceProjects');
  });

  it('leaves a project that is too young', async () => {
    const id = leftoverProject(PROJECT_RUN, { ageMs: 60_000 });
    const report = await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
    expect(report.projects).toMatchObject({ removed: 0,
      skipped: 1 });
    expect(createdProjects(history).ids()).toEqual([id]);
  });

  it('leaves a project of a run that is still going', async () => {
    const id = leftoverProject(PROJECT_RUN);

    active.add(PROJECT_RUN);
    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
  });

  it('does not touch a project with the same name in another workspace', async () => {
    const id = leftoverProject(PROJECT_RUN, { workspaceId: 'foreign-workspace' });
    const report = await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
    expect(hawk.api.operations).not.toContain('RemoveProject');
    expect(report.projects).toMatchObject({ removed: 0,
      skipped: 1 });
  });

  it('does not touch the monitored project, even when its id is in the record', async () => {
    createdProjects(history).record(hawk.projectId);

    const main = hawk.projects.get(hawk.projectId);

    if (main) {
      main.name = `[e2e:${INSTANCE}] new-project ${PROJECT_RUN}`;
      main.creationDate = Date.now() - 2 * HOUR_MS;
    }

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(hawk.projectId)).toBe(true);
    expect(hawk.api.operations).not.toContain('RemoveProject');
  });

  it('does not touch a project with a fitting name that the monitor did not record', async () => {
    const id = leftoverProject(PROJECT_RUN, { recorded: false });

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
    expect(hawk.api.operations).not.toContain('WorkspaceProjects');
  });

  it.each([
    ['another instance', `[e2e:other] new-project ${PROJECT_RUN}`],
    ['a longer run id', `[e2e:${INSTANCE}] new-project ${PROJECT_RUN}x`],
    ['an upper case run id', `[e2e:${INSTANCE}] new-project Raaaaaaaaaaaaaaa`],
    ['a prefix before the mark', `x [e2e:${INSTANCE}] new-project ${PROJECT_RUN}`],
    ['another scenario', `[e2e:${INSTANCE}] sourcemaps ${PROJECT_RUN}`],
  ])('does not touch a recorded project whose name is of %s', async (_label, name) => {
    const id = leftoverProject(PROJECT_RUN, { name });

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
  });

  it('matches the instance id literally, dots and all', async () => {
    const id = leftoverProject(PROJECT_RUN, { name: `[e2e:f.ke] new-project ${PROJECT_RUN}` });

    await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(id)).toBe(true);
  });

  it('forgets a recorded project that Hawk no longer has', async () => {
    const id = leftoverProject(PROJECT_RUN);

    hawk.projects.remove(id);

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report.projects).toEqual({ removed: 0,
      gone: 1,
      skipped: 0 });
    expect(createdProjects(history).ids()).toEqual([]);
    expect(hawk.api.operations).not.toContain('RemoveProject');
  });

  it('keeps the record when Hawk says it removed nothing or fails, and goes on with the pass', async () => {
    const id = leftoverProject(PROJECT_RUN);

    hawk.api.knobs.errors = Object.fromEntries([['RemoveProject', { code: 'INTERNAL_SERVER_ERROR',
      message: 'boom' }]]);

    const report = await sweeper().sweepOnce(SIGNAL);

    expect(report.error).toContain('boom');
    expect(hawk.projects.has(id)).toBe(true);
    expect(createdProjects(history).ids()).toEqual([id]);
  });

  it('a project that the cleanup of its run could not remove goes in a later pass', async () => {
    const id = leftoverProject(PROJECT_RUN, { ageMs: 60_000 });

    await sweeper().sweepOnce(SIGNAL);
    expect(hawk.projects.has(id)).toBe(true);

    const project = hawk.projects.get(id);

    if (project) {
      project.creationDate = Date.now() - 2 * HOUR_MS;
    }

    await sweeper().sweepOnce(SIGNAL);
    expect(hawk.projects.has(id)).toBe(false);
  });

  it('removes every old project of the record in one pass', async () => {
    const first = leftoverProject('raaaaaaaaaaaaaaa');
    const second = leftoverProject('rbbbbbbbbbbbbbbb');
    const report = await sweeper().sweepOnce(SIGNAL);

    expect(hawk.projects.has(first)).toBe(false);
    expect(hawk.projects.has(second)).toBe(false);
    expect(report.projects?.removed).toBe(2);
  });

  it('reports an error and removes nothing when the monitored project is not in any workspace', async () => {
    const id = leftoverProject(PROJECT_RUN);

    const report = await sweeper({ api: { ...api,
      workspaceProjects: async () => Promise.resolve([{ workspaceId: 'fake-workspace',
        projects: [] }]) } }).sweepOnce(SIGNAL);

    expect(report.error).toContain('monitored project');
    expect(hawk.projects.has(id)).toBe(true);
  });
});
