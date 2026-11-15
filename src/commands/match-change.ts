import type { Config } from '../config/load.js';
import { existsSync } from 'node:fs';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';
import type { CheckIo } from './check.js';

/**
 * Turns a thrown value into text.
 * @param error Anything thrown, such as an `Error` or a string.
 * @returns The message of an `Error`, otherwise the value as text.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the time of the last change of the rule matching; undefined when the database or the key is absent.
 * A missing database is not created for the read.
 * @param config Validated configuration.
 * @param io Output streams; a failed read is reported to stderr only.
 * @returns Wall-clock time in milliseconds, or undefined.
 */
export function readMatchChange(config: Config, io: CheckIo): number | undefined {
  const { databasePath } = config.monitoring;

  if (!existsSync(databasePath)) {
    return undefined;
  }

  try {
    const history = createHistory(openDatabase(databasePath, { readOnly: true }));

    try {
      const stored = Date.parse(history.getKv(MATCH_CHANGED_KEY) ?? '');

      return Number.isNaN(stored) ? undefined : stored;
    } finally {
      history.close();
    }
  } catch (error) {
    io.stderr(`could not read the rule change time from ${databasePath}: ${messageOf(error)}\n`);

    return undefined;
  }
}

/**
 * Tells `serve` when matching changed, so it does not trust the old rule after a restart.
 * A failed write is only reported: the rule itself was changed.
 * @param config Validated configuration.
 * @param at Time of the change.
 * @param io Output streams.
 */
export function recordMatchChange(config: Config, at: Date, io: CheckIo): void {
  try {
    const history = createHistory(openDatabase(config.monitoring.databasePath));

    try {
      history.setKv(MATCH_CHANGED_KEY, at.toISOString());
    } finally {
      history.close();
    }
  } catch (error) {
    io.stderr(`could not record the rule change in ${config.monitoring.databasePath}: ${messageOf(error)}\n`);
  }
}
