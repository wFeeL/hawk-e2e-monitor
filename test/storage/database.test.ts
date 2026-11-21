import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { AlertStateRow } from '../../src/storage/types.js';

const SCENARIO = 'send-and-receive-event';
const AT = '2026-03-10T12:00:00.000Z';
const LOCK_HOLD_MS = 400;

// The creation script of version 1, copied on purpose: the test must not follow changes of `src`.
const V1 = `
CREATE TABLE runs (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, scenario TEXT NOT NULL,
  sequence INTEGER NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, duration_ms INTEGER, event_latency_ms INTEGER, failed_stage TEXT,
  error_class TEXT, culprit TEXT, message TEXT, skip_reason TEXT, degraded TEXT NOT NULL DEFAULT '[]',
  late_event_found_at TEXT, late_event_delay_ms INTEGER, late_notification_at TEXT,
  late_notification_channel TEXT, late_duplicate_notification_at TEXT, result_json TEXT);
CREATE INDEX runs_scenario_started ON runs (scenario, started_at);
CREATE TABLE stages (run_pk INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL, duration_ms INTEGER NOT NULL, error_class TEXT, culprit TEXT,
  PRIMARY KEY (run_pk, position));
CREATE TABLE alert_state (scenario TEXT PRIMARY KEY, state TEXT NOT NULL, failure_streak INTEGER NOT NULL,
  last_class TEXT, last_stage TEXT, last_run_id TEXT, episode_started_at TEXT, episode_failures INTEGER NOT NULL DEFAULT 0,
  degraded TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
CREATE TABLE alert_outbox (id INTEGER PRIMARY KEY, scenario TEXT NOT NULL, run_id TEXT, text TEXT NOT NULL,
  created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  sent_at TEXT, dropped_at TEXT, last_error TEXT);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
const V1_ROW = `INSERT INTO alert_state (scenario, state, failure_streak, last_class, last_stage, episode_started_at, episode_failures, updated_at)
  VALUES ('${SCENARIO}', 'failing', 2, 'event_not_found', 'event_visible', '${AT}', 2, '${AT}');
INSERT INTO alert_outbox (scenario, text, created_at, next_attempt_at) VALUES ('${SCENARIO}', 'old', '${AT}', '${AT}');`;
const CHILD = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
setTimeout(() => {
  db.exec("ALTER TABLE alert_state ADD COLUMN open TEXT NOT NULL DEFAULT '[]'");
  db.exec('ALTER TABLE alert_state ADD COLUMN announced INTEGER NOT NULL DEFAULT 1');
  db.exec('ALTER TABLE alert_state ADD COLUMN streak_started_at TEXT');
  db.exec("ALTER TABLE alert_state ADD COLUMN reported TEXT NOT NULL DEFAULT '[]'");
  db.exec('ALTER TABLE alert_outbox ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0');
  db.exec('PRAGMA user_version = 2');
  db.exec('COMMIT');
  db.close();
}, ${String(LOCK_HOLD_MS)});
`;

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
  const directory = await mkdtemp(join(tmpdir(), 'database-'));

  directories.push(directory);

  return directory;
}

/**
 * Builds a file of version 1 with one failing alert and one queued message.
 * @returns Path of the file.
 */
async function versionOneFile(): Promise<string> {
  const path = join(await tempDir(), 'monitor.db');
  const raw = new DatabaseSync(path);

  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(V1);
  raw.exec(V1_ROW);
  raw.exec('PRAGMA user_version = 1');
  raw.close();

  return path;
}

/**
 * Reads `user_version`.
 * @param db Open database.
 * @returns Value of the pragma.
 */
function versionOf(db: DatabaseSync): unknown {
  return db.prepare('PRAGMA user_version').get()?.user_version;
}

/**
 * Lists the column names of a table.
 * @param db Open database.
 * @param table Table name.
 * @returns Column names.
 */
function columnsOf(db: DatabaseSync, table: string): unknown[] {
  return db.prepare(`PRAGMA table_info(${table})`)
    .all()
    .map(row => row.name);
}

/** A child process that holds the write lock. */
interface LockingChild {
  /** Resolves with the exit code. */
  done: Promise<number | null>;
}

/**
 * Starts a child that holds the write lock of a file and migrates it by hand.
 * @param path Database file.
 * @returns Resolves when the child holds the lock; `done` resolves when it exited.
 */
async function lockingChild(path: string): Promise<LockingChild> {
  const child = spawn(process.execPath, ['-e', CHILD, path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const done = once(child, 'exit').then(([code]) => code as number | null);

  await once(child.stdout, 'data');

  return { done };
}

describe('schema version 2', () => {
  it('moves a version 1 file to version 2 and keeps its rows readable as announced with no open pairs', async () => {
    const path = await versionOneFile();
    const db = openDatabase(path);

    expect(SCHEMA_VERSION).toBe(2);
    expect(versionOf(db)).toBe(2);

    const history = createHistory(db);

    expect(history.alertState(SCENARIO)).toEqual({ scenario: SCENARIO,
      state: 'failing',
      failureStreak: 2,
      lastClass: 'event_not_found',
      lastStage: 'event_visible',
      episodeStartedAt: AT,
      episodeFailures: 2,
      degraded: [],
      open: [],
      announced: true,
      reported: [],
      updatedAt: AT });
    expect(history.pendingAlerts(AT, 10)).toMatchObject([{ text: 'old',
      rejections: 0 }]);
    history.close();
  });

  it('creates an empty file at version 2 with every column', async () => {
    const db = openDatabase(join(await tempDir(), 'monitor.db'));

    expect(versionOf(db)).toBe(2);
    expect(columnsOf(db, 'alert_state')).toEqual(expect.arrayContaining(['open', 'announced', 'streak_started_at', 'reported']));
    expect(columnsOf(db, 'alert_outbox')).toContain('rejections');
    db.close();
  });

  it('opens a migrated file again without migrating twice', async () => {
    const path = await versionOneFile();

    openDatabase(path).close();

    const db = openDatabase(path);

    expect(versionOf(db)).toBe(2);
    db.close();
  });

  it('rejects a file of version 3', async () => {
    const path = join(await tempDir(), 'monitor.db');
    const raw = new DatabaseSync(path);

    raw.exec('PRAGMA user_version = 3');
    raw.close();

    expect(() => openDatabase(path)).toThrow('written by a newer version');
  });

  it('a second process that waited for the lock finds version 2 and skips the steps', async () => {
    const path = await versionOneFile();
    const child = await lockingChild(path);
    const db = openDatabase(path);

    expect(versionOf(db)).toBe(2);
    expect(await child.done).toBe(0);
    db.close();
  });

  it('round trips the episode fields and the rejection counter', () => {
    const history = createHistory(openDatabase(':memory:'));
    const state: AlertStateRow = { scenario: SCENARIO,
      state: 'failing',
      failureStreak: 1,
      episodeFailures: 1,
      degraded: [],
      open: [{ pair: 'event_visible@ws',
        count: 2 }, { pair: 'run@*',
        count: 1 }],
      announced: false,
      streakStartedAt: AT,
      reported: ['event_visible/event_not_found'],
      updatedAt: AT };

    history.saveAlert(state, { text: 'x',
      at: AT });

    expect(history.alertState(SCENARIO)).toEqual(state);
    expect(history.alertStates()).toEqual([state]);

    history.alertRejected(1, '2026-03-10T12:05:00.000Z', 'FAIL');
    history.alertRejected(1, '2026-03-10T12:10:00.000Z', 'FAIL again');
    expect(history.pendingAlerts('2026-03-10T12:09:00.000Z', 10)).toEqual([]);
    expect(history.pendingAlerts('2026-03-10T12:10:00.000Z', 10)).toMatchObject([{ attempts: 2,
      rejections: 2 }]);
    history.close();
  });
});
