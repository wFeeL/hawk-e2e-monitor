import type { DatabaseSync } from 'node:sqlite';
import { createAlertStore } from './alerts.js';
import type { AlertStore } from './alerts.js';
import { createKvStore } from './kv.js';
import type { KvStore } from './kv.js';
import { createRunStore } from './runs.js';
import type { RunStore } from './runs.js';
import { createSql } from './sql.js';
import { createStatsStore } from './stats.js';
import type { StatsStore } from './stats.js';
import type { PruneOptions } from './types.js';

/** Storage of runs, alert state and small values. */
export interface History extends AlertStore, KvStore, RunStore, StatsStore {
  /**
   * Deletes old data.
   * @param before ISO time.
   * @param options Limits the deletion to one scenario.
   * @returns Number of runs deleted, those that finished before it; delivered or dropped alerts before it go too.
   */
  prune(before: string, options?: PruneOptions): number;
  /** Closes the database. */
  close(): void;
}

/**
 * Creates the history over an open database.
 * @param db Database from `openDatabase`.
 * @returns History bound to it.
 */
export function createHistory(db: DatabaseSync): History {
  const sql = createSql(db);
  const { transaction, run } = sql;

  const prune: History['prune'] = (before, options = {}) => {
    return transaction(() => {
      if (options.scenario === undefined && options.exceptScenarios !== undefined) {
        const marks = options.exceptScenarios.map(() => '?').join(', ');
        const listed = options.exceptScenarios.length === 0 ? '' : ` AND scenario NOT IN (${marks})`;
        const removed = run(`DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?${listed}`, before, ...options.exceptScenarios);

        run(`DELETE FROM alert_outbox WHERE (sent_at < ? OR dropped_at < ?)${listed}`, before, before, ...options.exceptScenarios);

        return removed;
      }

      if (options.scenario === undefined) {
        const removed = run('DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ?', before);

        run('DELETE FROM alert_outbox WHERE sent_at < ? OR dropped_at < ?', before, before);

        return removed;
      }

      const removed = run('DELETE FROM runs WHERE scenario = ? AND finished_at IS NOT NULL AND finished_at < ?', options.scenario, before);

      run('DELETE FROM alert_outbox WHERE scenario = ? AND (sent_at < ? OR dropped_at < ?)', options.scenario, before, before);

      return removed;
    });
  };

  const close: History['close'] = () => {
    db.close();
  };

  return {
    ...createAlertStore(sql),
    ...createKvStore(sql),
    ...createRunStore(sql),
    ...createStatsStore(sql),
    prune,
    close,
  };
}
