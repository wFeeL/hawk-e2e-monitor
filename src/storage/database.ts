import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Version of the schema this code writes. */
export const SCHEMA_VERSION = 2;

const BUSY_TIMEOUT_MS = 5000;

/** Options of `openDatabase`. */
export interface OpenOptions {
  /** Open for reading only: no directory is created and nothing is migrated. */
  readOnly?: boolean;
}

/** The file exists but holds no history yet. */
export class EmptyDatabaseError extends Error {
  /** Creates the error. */
  constructor() {
    super('DATABASE_PATH holds no history yet');
    this.name = 'EmptyDatabaseError';
  }
}

const SCHEMA_V1 = `
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

const MIGRATE_V2 = `
ALTER TABLE alert_state ADD COLUMN open TEXT NOT NULL DEFAULT '[]';
ALTER TABLE alert_state ADD COLUMN announced INTEGER NOT NULL DEFAULT 1;
ALTER TABLE alert_state ADD COLUMN streak_started_at TEXT;
ALTER TABLE alert_state ADD COLUMN reported TEXT NOT NULL DEFAULT '[]';
ALTER TABLE alert_outbox ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0;
`;

/**
 * Reads the schema version of the file.
 * @param db Open database.
 * @returns Value of `PRAGMA user_version`.
 */
function versionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();

  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/**
 * Brings a database to the current version in one transaction.
 * @param db Open database.
 */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');

  try {
    // Another process may have migrated while this one waited for the lock, so each step reads the version again.
    if (versionOf(db) === 0) {
      db.exec(SCHEMA_V1);
      db.exec('PRAGMA user_version = 1');
    }

    if (versionOf(db) === 1) {
      db.exec(MIGRATE_V2);
      db.exec('PRAGMA user_version = 2');
    }

    db.exec('COMMIT');
  } catch (error) {
    // SQLite rolls back by itself on some errors, and a second rollback would replace the error.
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }

    throw error;
  }
}

/**
 * Opens the history file, creates its directory (not when read-only), sets WAL and the busy timeout, and runs migrations.
 * @param path File path, or `:memory:`.
 * @param options Read-only switch.
 * @returns Open database with foreign keys on.
 * @throws Error when the file was written by a newer version, or `EmptyDatabaseError` for an empty file opened read-only.
 */
export function openDatabase(path: string, options: OpenOptions = {}): DatabaseSync {
  const readOnly = options.readOnly === true;

  if (readOnly && !existsSync(path)) {
    throw new Error(`No database file at ${path}`);
  }

  if (!readOnly && path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path, { readOnly });

  try {
    db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);

    const version = versionOf(db);

    if (version > SCHEMA_VERSION) {
      throw new Error('DATABASE_PATH was written by a newer version of the monitor');
    }

    if (readOnly) {
      if (version === 0) {
        throw new EmptyDatabaseError();
      }
    } else {
      db.exec('PRAGMA journal_mode = WAL');

      if (version < SCHEMA_VERSION) {
        migrate(db);
      }
    }

    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}
