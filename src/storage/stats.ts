import type { StageName } from '../engine/result.js';
import type { ErrorClass } from '../errors/taxonomy.js';
import type { ScenarioName } from '../scenarios/names.js';
import { MS_PER_DAY } from '../time/units.js';
import { isMonitorAbort } from './outcome.js';
import { num, required, text } from './rows.js';
import type { Sql } from './sql.js';
import type { RunStatus, ScenarioStats, StatsWindow } from './types.js';

const WINDOW_DAYS = 7;
const SHORT_WINDOW_DAYS = 1;
const P50 = 0.5;
const P95 = 0.95;

/** Figures over time windows. */
export interface StatsStore {
  /**
   * Computes statistics.
   * @param now End of the windows.
   * @param scenarios Scenarios to report, in order.
   * @returns One entry per scenario.
   */
  stats(now: Date, scenarios: readonly ScenarioName[]): ScenarioStats[];
}

/**
 * Takes the value at a nearest-rank percentile.
 * @param sorted Values in ascending order.
 * @param fraction Percentile as a fraction.
 * @returns The value, or null for an empty list.
 */
function nearestRank(sorted: readonly number[], fraction: number): number | null {
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

/**
 * Creates the statistics over a database.
 * @param sql Helpers bound to the database.
 * @returns Store bound to it.
 */
export function createStatsStore(sql: Sql): StatsStore {
  const { all, one } = sql;

  const windowStats = (scenario: ScenarioName, since: string): StatsWindow => {
    const rows = all('SELECT status, error_class, event_latency_ms, late_event_found_at, late_notification_at, late_duplicate_notification_at FROM runs WHERE scenario = ? AND started_at >= ?', scenario, since);
    const counts = { ok: 0,
      failed: 0,
      aborted: 0,
      monitorAborts: 0,
      skipped: 0 };
    const latencies: number[] = [];
    let lateEvents = 0;
    let lateNotifications = 0;
    let lateDuplicateNotifications = 0;

    for (const row of rows) {
      const status = text(row, 'status');
      const errorClass = text(row, 'error_class') as ErrorClass | undefined;

      if (status === 'ok') {
        counts.ok += 1;

        const latency = num(row, 'event_latency_ms');

        if (latency !== undefined) {
          latencies.push(latency);
        }
      } else if (status === 'failed') {
        counts.failed += 1;
      } else if (status === 'aborted') {
        counts[isMonitorAbort({ status: 'aborted',
          ...errorClass === undefined ? {} : { errorClass } })
          ? 'monitorAborts'
          : 'aborted'] += 1;
      } else if (status === 'skipped') {
        counts.skipped += 1;
      }

      lateEvents += text(row, 'late_event_found_at') === undefined ? 0 : 1;
      lateNotifications += text(row, 'late_notification_at') === undefined ? 0 : 1;
      lateDuplicateNotifications += text(row, 'late_duplicate_notification_at') === undefined ? 0 : 1;
    }

    const denominator = counts.ok + counts.failed + counts.aborted;
    const sorted = latencies.toSorted((left, right) => left - right);
    const stageAvgMs: Partial<Record<StageName, number>> = {};

    for (const row of all('SELECT s.name AS name, AVG(s.duration_ms) AS mean FROM stages s JOIN runs r ON r.id = s.run_pk WHERE r.scenario = ? AND r.started_at >= ? AND r.status != \'running\' AND s.status != \'skipped\' GROUP BY s.name', scenario, since)) {
      stageAvgMs[required(row, 'name') as StageName] = Math.round(num(row, 'mean') ?? 0);
    }

    return { ...counts,
      successRatio: denominator === 0 ? null : counts.ok / denominator,
      eventLatencyP50Ms: nearestRank(sorted, P50),
      eventLatencyP95Ms: nearestRank(sorted, P95),
      stageAvgMs,
      lateEvents,
      lateNotifications,
      lateDuplicateNotifications };
  };

  const stats: StatsStore['stats'] = (now, scenarios) => {
    const since = (days: number): string => new Date(now.getTime() - days * MS_PER_DAY).toISOString();

    return scenarios.map((scenario) => {
      const last = one('SELECT run_id, status, started_at FROM runs WHERE scenario = ? ORDER BY started_at DESC, id DESC LIMIT 1', scenario);

      return { scenario,
        last24h: windowStats(scenario, since(SHORT_WINDOW_DAYS)),
        last7d: windowStats(scenario, since(WINDOW_DAYS)),
        ...last === undefined
          ? {}
          : { lastRun: { runId: required(last, 'run_id'),
              status: required(last, 'status') as RunStatus,
              startedAt: required(last, 'started_at') } } };
    });
  };

  return { stats };
}
