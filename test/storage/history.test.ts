import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/engine/result.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';
import { EmptyDatabaseError, openDatabase, SCHEMA_VERSION } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { AlertStateRow, History } from '../../src/storage/history.js';
import type { RunOutcome } from '../../src/storage/types.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const SCENARIO = 'send-and-receive-event';
const STAGE = 'collector_availability';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => rm(directory, { recursive: true,
    force: true })));
});

/**
 * Makes a temporary directory that is removed after the test.
 * @returns Path of the directory.
 */
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'history-'));

  directories.push(directory);

  return directory;
}

/**
 * Reads the single value of a pragma.
 * @param db Database to ask.
 * @param name Pragma to read.
 * @returns First column of the single row.
 */
function pragma(db: DatabaseSync, name: string): unknown {
  return Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
}

/**
 * Opens an in-memory history.
 * @returns History over a fresh database.
 */
function memoryHistory(): History {
  return createHistory(openDatabase(':memory:'));
}

/**
 * Shifts the reference time.
 * @param ms Milliseconds from `NOW`, negative for the past.
 * @returns ISO timestamp.
 */
function at(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

/** What a stored run needs besides its identity. */
interface Stored {
  /** Id of the run. */
  runId: string;
  /** Scenario, `send-and-receive-event` by default. */
  scenario?: 'check-notification' | 'send-and-receive-event';
  /** Run number, 1 by default. */
  sequence?: number;
  /** Start time, an hour before `NOW` by default. */
  startedAt?: string;
  /** Fields that replace the `ok` outcome. */
  outcome?: Partial<RunOutcome>;
  /** Result to store. */
  result?: RunResult;
}

/**
 * Starts and finishes a run.
 * @param history History to write to.
 * @param stored Identity and outcome of the run.
 */
function store(history: History, stored: Stored): void {
  const startedAt = stored.startedAt ?? at(-HOUR_MS);

  history.startRun({ runId: stored.runId,
    scenario: stored.scenario ?? SCENARIO,
    sequence: stored.sequence ?? 1,
    trigger: 'schedule',
    startedAt });
  history.finishRun(stored.runId, { status: 'ok',
    finishedAt: new Date(Date.parse(startedAt) + 5000).toISOString(),
    durationMs: 5000,
    degraded: [],
    ...stored.result === undefined ? {} : { result: stored.result },
    ...stored.outcome });
}

describe('openDatabase', () => {
  it('migrates an empty file to the current version', async () => {
    const path = join(await tempDir(), 'nested', 'monitor.db');
    const db = openDatabase(path);

    expect(pragma(db, 'user_version')).toBe(SCHEMA_VERSION);
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(pragma(db, 'journal_mode')).toBe('wal');

    const tables = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' ORDER BY name').all()
      .map(row => row.name);

    expect(tables).toEqual(expect.arrayContaining(['alert_outbox', 'alert_state', 'kv', 'runs', 'stages']));
    db.close();
  });

  it('refuses a newer schema', async () => {
    const path = join(await tempDir(), 'monitor.db');
    const raw = new DatabaseSync(path);

    raw.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION + 1)}`);
    raw.close();

    expect(() => openDatabase(path)).toThrow('DATABASE_PATH was written by a newer version of the monitor');
    expect(() => openDatabase(path, { readOnly: true })).toThrow('written by a newer version');
  });

  it('read-only open does not migrate and cannot write', async () => {
    const directory = await tempDir();
    const empty = join(directory, 'empty.db');
    const raw = new DatabaseSync(empty);

    raw.close();
    expect(() => openDatabase(empty, { readOnly: true })).toThrow(EmptyDatabaseError);

    const check = new DatabaseSync(empty);

    expect(pragma(check, 'user_version')).toBe(0);
    check.close();

    const filled = join(directory, 'filled.db');

    openDatabase(filled).close();

    const readOnly = openDatabase(filled, { readOnly: true });

    expect(() => createHistory(readOnly).setKv('a', 'b')).toThrow();
    expect(createHistory(readOnly).list({ limit: 5 })).toEqual([]);
    readOnly.close();
  });

  it('read-only open of a missing file does not create it or its directory', async () => {
    const directory = await tempDir();

    expect(() => openDatabase(join(directory, 'nope', 'monitor.db'), { readOnly: true })).toThrow();
    expect(() => new DatabaseSync(join(directory, 'nope', 'monitor.db'), { readOnly: true })).toThrow();
  });
});

describe('sequence', () => {
  it('starts at 1, ignores skipped overlap rows, counts skipped warmup rows, is per scenario', () => {
    const history = memoryHistory();

    expect(history.nextSequence(SCENARIO)).toBe(1);

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      sequence: 1 });
    history.recordSkip({ runId: 'rbbbbbbbbbbbbbbbb',
      scenario: SCENARIO,
      sequence: 2,
      trigger: 'schedule',
      at: at(-1000),
      reason: 'overlap' });
    expect(history.nextSequence(SCENARIO)).toBe(2);

    store(history, { runId: 'rcccccccccccccccc',
      sequence: 2,
      outcome: { status: 'skipped',
        skipReason: 'rule_cache_warmup' } });
    expect(history.nextSequence(SCENARIO)).toBe(3);

    store(history, { runId: 'rdddddddddddddddd',
      scenario: 'check-notification',
      sequence: 7 });
    expect(history.nextSequence(SCENARIO)).toBe(3);
    expect(history.nextSequence('check-notification')).toBe(8);
  });
});

describe('runs', () => {
  it('finishRun stores the run and its stages in order', () => {
    const history = memoryHistory();
    const result = runResultFixture({ runId: 'raaaaaaaaaaaaaaaa',
      eventLatencyMs: 1234,
      stages: [stageFixture('collector_availability', 'ok', 11),
        stageFixture('event_visible', 'failed', 22, { errorClass: 'event_not_found',
          culprit: 'hawk' }),
        stageFixture('cleanup', 'ok', 33)] });

    history.startRun({ runId: 'raaaaaaaaaaaaaaaa',
      scenario: SCENARIO,
      sequence: 4,
      trigger: 'manual',
      startedAt: at(-2000) });
    expect(history.get('raaaaaaaaaaaaaaaa')).toMatchObject({ status: 'running',
      trigger: 'manual',
      sequence: 4,
      degraded: [],
      stages: [] });

    history.finishRun('raaaaaaaaaaaaaaaa', { status: 'failed',
      finishedAt: at(-1000),
      durationMs: 1000,
      degraded: ['single_channel'],
      errorClass: 'event_not_found',
      culprit: 'hawk',
      message: 'Event did not appear',
      failedStage: 'event_visible',
      result });

    const row = history.get('raaaaaaaaaaaaaaaa');

    expect(row).toMatchObject({ status: 'failed',
      finishedAt: at(-1000),
      durationMs: 1000,
      eventLatencyMs: 1234,
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk',
      message: 'Event did not appear',
      degraded: ['single_channel'] });
    expect(row?.stages).toEqual([
      { name: 'collector_availability',
        status: 'ok',
        durationMs: 11 },
      { name: 'event_visible',
        status: 'failed',
        durationMs: 22,
        errorClass: 'event_not_found',
        culprit: 'hawk' },
      { name: 'cleanup',
        status: 'ok',
        durationMs: 33 },
    ]);
    expect(row?.result).toEqual(result);
  });

  it('finishRun of an unknown runId throws', () => {
    expect(() => {
      memoryHistory().finishRun('rzzzzzzzzzzzzzzzz', { status: 'ok',
        finishedAt: at(0),
        durationMs: 1,
        degraded: [] });
    }).toThrow('rzzzzzzzzzzzzzzzz');
  });

  it('recordSkip writes a finished skipped row', () => {
    const history = memoryHistory();

    history.recordSkip({ runId: 'raaaaaaaaaaaaaaaa',
      scenario: SCENARIO,
      sequence: 3,
      trigger: 'schedule',
      at: at(-500),
      reason: 'overlap' });
    expect(history.get('raaaaaaaaaaaaaaaa')).toMatchObject({ status: 'skipped',
      skipReason: 'overlap',
      startedAt: at(-500),
      finishedAt: at(-500) });
  });

  it('abortRunning turns running rows into aborted monitor_restarted', () => {
    const history = memoryHistory();

    history.startRun({ runId: 'raaaaaaaaaaaaaaaa',
      scenario: SCENARIO,
      sequence: 1,
      trigger: 'schedule',
      startedAt: at(-60_000) });
    store(history, { runId: 'rbbbbbbbbbbbbbbbb',
      sequence: 2 });

    expect(history.abortRunning('monitor_restarted', at(0))).toBe(1);
    expect(history.get('raaaaaaaaaaaaaaaa')).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_restarted',
      culprit: 'monitor',
      finishedAt: at(0),
      durationMs: 60_000 });
    expect(history.get('rbbbbbbbbbbbbbbbb')?.status).toBe('ok');
    expect(history.abortRunning('monitor_restarted', at(0))).toBe(0);
  });

  it('list returns newest first, filtered by scenario, up to the limit', () => {
    const history = memoryHistory();

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      startedAt: at(-3 * HOUR_MS) });
    store(history, { runId: 'rbbbbbbbbbbbbbbbb',
      scenario: 'check-notification',
      startedAt: at(-2 * HOUR_MS) });
    store(history, { runId: 'rcccccccccccccccc',
      startedAt: at(-HOUR_MS) });

    expect(history.list({ limit: 10 }).map(row => row.runId)).toEqual(['rcccccccccccccccc', 'rbbbbbbbbbbbbbbbb', 'raaaaaaaaaaaaaaaa']);
    expect(history.list({ scenario: SCENARIO,
      limit: 10 }).map(row => row.runId)).toEqual(['rcccccccccccccccc', 'raaaaaaaaaaaaaaaa']);
    expect(history.list({ limit: 1 })).toHaveLength(1);
    expect(history.get('rnnnnnnnnnnnnnnnn')).toBeUndefined();
  });
});

describe('stats', () => {
  /**
   * Fills the fixture of the spec: 3 ok, 1 failed, 1 skipped, 2 aborted, plus rows outside the 24 h window.
   * @returns History with the fixture.
   */
  function fixture(): History {
    const history = memoryHistory();
    const okResult = (runId: string, latency: number, availability: number): RunResult => runResultFixture({ runId,
      eventLatencyMs: latency,
      stages: [stageFixture('collector_availability', 'ok', availability),
        stageFixture('event_repeated', 'skipped', 0)] });

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      startedAt: at(-HOUR_MS),
      result: okResult('raaaaaaaaaaaaaaaa', 1000, 100) });
    store(history, { runId: 'rbbbbbbbbbbbbbbbb',
      startedAt: at(-2 * HOUR_MS),
      result: okResult('rbbbbbbbbbbbbbbbb', 2000, 200) });
    store(history, { runId: 'rcccccccccccccccc',
      startedAt: at(-3 * HOUR_MS),
      result: okResult('rcccccccccccccccc', 3000, 300) });
    store(history, { runId: 'rdddddddddddddddd',
      startedAt: at(-4 * HOUR_MS),
      outcome: { status: 'failed',
        errorClass: 'event_not_found' },
      result: runResultFixture({ runId: 'rdddddddddddddddd',
        status: 'failed',
        stages: [stageFixture('collector_availability', 'failed', 400)] }) });
    history.recordSkip({ runId: 'reeeeeeeeeeeeeeee',
      scenario: SCENARIO,
      sequence: 9,
      trigger: 'schedule',
      at: at(-5 * HOUR_MS),
      reason: 'overlap' });
    store(history, { runId: 'rffffffffffffffff',
      startedAt: at(-6 * HOUR_MS),
      outcome: { status: 'aborted',
        errorClass: 'monitor_stopped' } });
    store(history, { runId: 'rgggggggggggggggg',
      startedAt: at(-7 * HOUR_MS),
      outcome: { status: 'aborted',
        errorClass: 'run_hung' } });
    // Older than 24 h: the 7 day window only.
    store(history, { runId: 'rhhhhhhhhhhhhhhhh',
      startedAt: at(-30 * HOUR_MS),
      result: okResult('rhhhhhhhhhhhhhhhh', 9000, 1000) });
    // Older than 7 days: no window.
    store(history, { runId: 'riiiiiiiiiiiiiiii',
      startedAt: at(-8 * 24 * HOUR_MS),
      result: okResult('riiiiiiiiiiiiiiii', 50_000, 50_000) });

    return history;
  }

  it('stats on the fixture', () => {
    const [stats] = fixture().stats(NOW, [SCENARIO]);

    expect(stats?.scenario).toBe(SCENARIO);
    expect(stats?.last24h).toEqual({
      ok: 3,
      failed: 1,
      aborted: 1,
      monitorAborts: 1,
      skipped: 1,
      successRatio: 0.6,
      eventLatencyP50Ms: 2000,
      eventLatencyP95Ms: 3000,
      stageAvgMs: { [STAGE]: 250 },
      lateEvents: 0,
      lateNotifications: 0,
      lateDuplicateNotifications: 0,
    });
    expect(stats?.last7d).toMatchObject({ ok: 4,
      failed: 1,
      aborted: 1,
      monitorAborts: 1,
      skipped: 1,
      eventLatencyP50Ms: 2000,
      eventLatencyP95Ms: 9000,
      stageAvgMs: { [STAGE]: 400 } });
    expect(stats?.last7d.successRatio).toBeCloseTo(4 / 6);
    expect(stats?.lastRun).toEqual({ runId: 'raaaaaaaaaaaaaaaa',
      status: 'ok',
      startedAt: at(-HOUR_MS) });
  });

  it('gives null ratios and percentiles on an empty window and keeps the scenario order', () => {
    const [first, second] = fixture().stats(NOW, ['check-notification', SCENARIO]);

    expect(first).toMatchObject({ scenario: 'check-notification' });
    expect(first?.lastRun).toBeUndefined();
    expect(first?.last24h).toMatchObject({ ok: 0,
      successRatio: null,
      eventLatencyP50Ms: null,
      eventLatencyP95Ms: null,
      stageAvgMs: {} });
    expect(second?.scenario).toBe(SCENARIO);
  });

  it('counts late marks in the window', () => {
    const history = fixture();

    store(history, { runId: 'rjjjjjjjjjjjjjjjj',
      startedAt: at(-HOUR_MS / 2),
      outcome: { status: 'failed',
        errorClass: 'event_not_found' } });
    history.markLateEvent('rjjjjjjjjjjjjjjjj', at(0), 1000);
    history.markLateNotification('rjjjjjjjjjjjjjjjj', 'webhook', at(0));
    history.markLateNotification('rjjjjjjjjjjjjjjjj', 'webhook', at(0));

    expect(history.stats(NOW, [SCENARIO])[0]?.last24h).toMatchObject({ lateEvents: 1,
      lateNotifications: 1,
      lateDuplicateNotifications: 1 });
  });
});

describe('late marks', () => {
  it('markLateEvent only on failed runs, once', () => {
    const history = memoryHistory();

    store(history, { runId: 'raaaaaaaaaaaaaaaa' });
    store(history, { runId: 'rbbbbbbbbbbbbbbbb',
      outcome: { status: 'failed' } });

    expect(history.markLateEvent('raaaaaaaaaaaaaaaa', at(0), 10)).toBe(false);
    expect(history.markLateEvent('rnnnnnnnnnnnnnnnn', at(0), 10)).toBe(false);
    expect(history.markLateEvent('rbbbbbbbbbbbbbbbb', at(0), 70_000)).toBe(true);
    expect(history.markLateEvent('rbbbbbbbbbbbbbbbb', at(5), 80_000)).toBe(false);
    expect(history.get('rbbbbbbbbbbbbbbbb')).toMatchObject({ lateEventFoundAt: at(0),
      lateEventDelayMs: 70_000 });
  });

  it('markLateNotification writes late once, duplicate for a channel with latencyMs', () => {
    const history = memoryHistory();

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      result: runResultFixture({ runId: 'raaaaaaaaaaaaaaaa',
        scenario: 'check-notification',
        notification: { webhook: { latencyMs: 900 },
          unmatched: 0 } }) });

    // The webhook already arrived in the run: a second POST is a duplicate.
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'webhook', at(1))).toBe('duplicate');
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'webhook', at(2))).toBeUndefined();
    // The loop never came: its first POST is late, only once.
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'loop', at(3))).toBe('late');
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'loop', at(4))).toBeUndefined();
    expect(history.get('raaaaaaaaaaaaaaaa')).toMatchObject({ lateNotificationAt: at(3),
      lateNotificationChannel: 'loop',
      lateDuplicateNotificationAt: at(1) });
    expect(history.markLateNotification('rnnnnnnnnnnnnnnnn', 'loop', at(0))).toBeUndefined();
  });

  it('a second late POST of the late channel is a duplicate, of the other channel nothing', () => {
    const history = memoryHistory();

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      outcome: { status: 'failed' } });

    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'webhook', at(1))).toBe('late');
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'loop', at(2))).toBeUndefined();
    expect(history.markLateNotification('raaaaaaaaaaaaaaaa', 'webhook', at(3))).toBe('duplicate');
  });
});

describe('alerts', () => {
  const state: AlertStateRow = { scenario: SCENARIO,
    state: 'failing',
    failureStreak: 2,
    lastClass: 'event_not_found',
    lastStage: 'event_visible',
    lastRunId: 'raaaaaaaaaaaaaaaa',
    episodeStartedAt: at(-1000),
    episodeFailures: 2,
    degraded: ['quota_projection'],
    updatedAt: at(0) };

  it('saveAlert writes state and outbox, alertState reads them back', () => {
    const history = memoryHistory();

    expect(history.alertState(SCENARIO)).toBeUndefined();
    history.saveAlert(state, { text: '<b>FAILED</b>',
      runId: 'raaaaaaaaaaaaaaaa',
      at: at(0) });
    history.saveAlert({ ...state,
      state: 'ok' });

    expect(history.alertState(SCENARIO)).toMatchObject({ state: 'ok',
      failureStreak: 2,
      degraded: ['quota_projection'] });
    expect(history.pendingAlerts(at(0), 10)).toEqual([{ id: 1,
      scenario: SCENARIO,
      runId: 'raaaaaaaaaaaaaaaa',
      text: '<b>FAILED</b>',
      createdAt: at(0),
      attempts: 0,
      nextAttemptAt: at(0) }]);
  });

  it('saveAlert writes state and outbox in one transaction', () => {
    const db = openDatabase(':memory:');
    const history = createHistory(db);

    history.saveAlert({ ...state,
      state: 'ok' });
    db.exec('CREATE TRIGGER outbox_fails BEFORE INSERT ON alert_outbox BEGIN SELECT RAISE(ABORT, \'disk full\'); END');

    expect(() => {
      history.saveAlert(state, { text: 'x',
        at: at(0) });
    }).toThrow('disk full');
    expect(history.alertState(SCENARIO)?.state).toBe('ok');
  });

  it('pendingAlerts returns due rows oldest first', () => {
    const history = memoryHistory();

    history.saveAlert(state, { text: 'second',
      at: at(10) });
    history.saveAlert(state, { text: 'first',
      at: at(5) });
    history.saveAlert(state, { text: 'later',
      at: at(100) });
    history.alertAttempt(3, { nextAttemptAt: at(500) });

    expect(history.pendingAlerts(at(50), 10).map(row => row.text)).toEqual(['first', 'second']);
    expect(history.pendingAlerts(at(50), 1)).toHaveLength(1);
    expect(history.pendingAlerts(at(1000), 10).map(row => row.text)).toEqual(['first', 'second', 'later']);
  });

  it('alertAttempt counts the attempt, hides sent and dropped rows, oldestUnsentAlert sees not yet due rows', () => {
    const history = memoryHistory();

    history.saveAlert(state, { text: 'a',
      at: at(0) });
    history.saveAlert(state, { text: 'b',
      at: at(10) });
    history.saveAlert(state, { text: 'c',
      at: at(20) });

    history.alertAttempt(1, { nextAttemptAt: at(5000),
      error: 'HTTP 500' });
    expect(history.pendingAlerts(at(100), 10).map(row => row.text)).toEqual(['b', 'c']);
    expect(history.oldestUnsentAlert()).toBe(at(0));

    history.alertAttempt(1, { sentAt: at(6000) });
    history.alertAttempt(2, { droppedAt: at(6000) });
    expect(history.oldestUnsentAlert()).toBe(at(20));
    expect(history.pendingAlerts(at(10_000), 10).map(row => ({ text: row.text,
      attempts: row.attempts }))).toEqual([{ text: 'c',
      attempts: 0 }]);
    history.alertAttempt(3, { sentAt: at(7000) });
    expect(history.oldestUnsentAlert()).toBeUndefined();
  });

  it('keeps values in kv', () => {
    const history = memoryHistory();

    expect(history.getKv('k')).toBeUndefined();
    history.setKv('k', 'one');
    history.setKv('k', 'two');
    expect(history.getKv('k')).toBe('two');
  });
});

describe('prune', () => {
  it('prune removes old runs with stages, finished outbox rows and keeps the rest', () => {
    const db = openDatabase(':memory:');
    const history = createHistory(db);
    const withStages = (runId: string): RunResult => runResultFixture({ runId });

    store(history, { runId: 'raaaaaaaaaaaaaaaa',
      startedAt: at(-40 * 24 * HOUR_MS),
      result: withStages('raaaaaaaaaaaaaaaa') });
    store(history, { runId: 'rbbbbbbbbbbbbbbbb',
      startedAt: at(-HOUR_MS),
      result: withStages('rbbbbbbbbbbbbbbbb') });
    history.startRun({ runId: 'rcccccccccccccccc',
      scenario: SCENARIO,
      sequence: 3,
      trigger: 'schedule',
      startedAt: at(-50 * 24 * HOUR_MS) });
    history.saveAlert({ scenario: SCENARIO,
      state: 'ok',
      failureStreak: 0,
      episodeFailures: 0,
      degraded: [],
      updatedAt: at(0) }, { text: 'old',
      at: at(-40 * 24 * HOUR_MS) });
    history.alertAttempt(1, { sentAt: at(-40 * 24 * HOUR_MS) });
    history.saveAlert({ scenario: SCENARIO,
      state: 'ok',
      failureStreak: 0,
      episodeFailures: 0,
      degraded: [],
      updatedAt: at(0) }, { text: 'unsent',
      at: at(-40 * 24 * HOUR_MS) });

    expect(history.prune(at(-30 * 24 * HOUR_MS))).toBe(1);
    expect(history.get('raaaaaaaaaaaaaaaa')).toBeUndefined();
    expect(history.get('rbbbbbbbbbbbbbbbb')?.stages).toHaveLength(5);
    expect(history.get('rcccccccccccccccc')?.status).toBe('running');
    expect(db.prepare('SELECT COUNT(*) AS n FROM stages').get()).toEqual({ n: 5 });
    expect(db.prepare('SELECT text FROM alert_outbox').all()
      .map(row => row.text)).toEqual(['unsent']);
  });
});

describe('persistence', () => {
  it('keeps rows after the file is reopened', async () => {
    const path = join(await tempDir(), 'monitor.db');
    const first = createHistory(openDatabase(path));

    store(first, { runId: 'raaaaaaaaaaaaaaaa' });
    first.close();

    const second = createHistory(openDatabase(path));

    expect(second.get('raaaaaaaaaaaaaaaa')?.status).toBe('ok');
    expect(second.nextSequence(SCENARIO)).toBe(2);
    second.close();
  });
});
