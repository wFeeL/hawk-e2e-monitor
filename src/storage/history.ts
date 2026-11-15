import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { RunResult, StageName } from '../engine/result.js';
import { CheckError, CULPRIT_OF } from '../errors/taxonomy.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';
import type { LateKind } from '../notifications/types.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { AlertLevelState, DegradedCode, RunOutcome, RunRow, RunStatus, RunTrigger, SkipReason, StageRow } from './types.js';
import { MS_PER_DAY } from '../time/units.js';
import { isMonitorAbort, isVerdict } from './outcome.js';
import type { VerdictOptions } from './outcome.js';

/** Runs a listing returns when the caller gives no limit. */
export const DEFAULT_LIST_LIMIT = 20;
const WINDOW_DAYS = 7;
const SHORT_WINDOW_DAYS = 1;
const P50 = 0.5;
const P95 = 0.95;

/** What `startRun` records. */
export interface RunStart {
  /** Random id of the run. */
  runId: string;
  /** Scenario. */
  scenario: ScenarioName;
  /** Run number within the scenario. */
  sequence: number;
  /** What started the run. */
  trigger: RunTrigger;
  /** Wall-clock start, ISO. */
  startedAt: string;
}

/** A tick that did not start a run. */
export interface SkipRecord {
  /** Id given to the row. */
  runId: string;
  /** Scenario. */
  scenario: ScenarioName;
  /** Number the next real run would get. */
  sequence: number;
  /** What would have started the run. */
  trigger: RunTrigger;
  /** Time of the tick, ISO. */
  at: string;
  /** Why it did not start. */
  reason: SkipReason;
}

/** Figures of one scenario over a time window. */
export interface StatsWindow {
  /** Runs that ended `ok`. */
  ok: number;
  /** Runs that ended `failed`. */
  failed: number;
  /** Runs aborted for a reason other than a stop or restart of the monitor. */
  aborted: number;
  /** Runs aborted by a stop or restart of the monitor. */
  monitorAborts: number;
  /** Runs that were skipped. */
  skipped: number;
  /** `ok / (ok + failed + aborted)`; null when the denominator is 0. */
  successRatio: number | null;
  /** Median event latency of `ok` runs, nearest rank. */
  eventLatencyP50Ms: number | null;
  /** 95th percentile of the event latency of `ok` runs, nearest rank. */
  eventLatencyP95Ms: number | null;
  /** Rounded mean duration per stage over stage rows that were not skipped, in finished runs. */
  stageAvgMs: Partial<Record<StageName, number>>;
  /** Failed runs whose event the sweep found later. */
  lateEvents: number;
  /** Runs that got a notification after they ended. */
  lateNotifications: number;
  /** Runs that got a repeated notification after they ended. */
  lateDuplicateNotifications: number;
}

/** Statistics of one scenario. */
export interface ScenarioStats {
  /** Scenario. */
  scenario: ScenarioName;
  /** Last 24 hours by start time. */
  last24h: StatsWindow;
  /** Last 7 days by start time. */
  last7d: StatsWindow;
  /** Latest run of any status. */
  lastRun?: Pick<RunRow, 'runId' | 'startedAt' | 'status'>;
}

/** Alert state of a scenario as stored. */
export interface AlertStateRow {
  /** Scenario. */
  scenario: ScenarioName;
  /** Level. */
  state: AlertLevelState;
  /** Failed runs in a row. */
  failureStreak: number;
  /** Class of the last failure. */
  lastClass?: string;
  /** Stage of the last failure. */
  lastStage?: string;
  /** Run of the last failure. */
  lastRunId?: string;
  /** Start of the run that opened the episode. */
  episodeStartedAt?: string;
  /** Failed runs in the episode. */
  episodeFailures: number;
  /** Degradation codes of the last `ok` run. */
  degraded: DegradedCode[];
  /** Last change, ISO. */
  updatedAt: string;
}

/** An alert waiting for delivery. */
export interface OutboxRow {
  /** Database key. */
  id: number;
  /** Scenario. */
  scenario: ScenarioName;
  /** Run that caused the alert. */
  runId?: string;
  /** Text to send. */
  text: string;
  /** When it was queued, ISO. */
  createdAt: string;
  /** Delivery attempts so far. */
  attempts: number;
  /** Earliest next attempt, ISO. */
  nextAttemptAt: string;
}

/** What `alertAttempt` records. */
export interface AlertAttempt {
  /** Delivery time. */
  sentAt?: string;
  /** Earliest next attempt. */
  nextAttemptAt?: string;
  /** Time the message was given up on. */
  droppedAt?: string;
  /** Text of the failure. */
  error?: string;
}

/** A run row with its full result. */
export type RunWithResult = RunRow & {
  /** Result as the scenario returned it. */
  result?: RunResult;
};

/** Filter and size of `list`. */
export interface ListOptions {
  /** Only runs of this scenario. */
  scenario?: ScenarioName;
  /** Leaves out the runs of these scenarios. */
  exceptScenarios?: readonly ScenarioName[];
  /** Most rows to return. */
  limit: number;
}

/** What `prune` is limited to. */
export interface PruneOptions {
  /** Only runs and delivered alerts of this scenario; all of them by default. */
  scenario?: ScenarioName;
  /** Only runs and delivered alerts of scenarios that are not listed, such as ones the code no longer knows; ignored with `scenario`. */
  exceptScenarios?: readonly ScenarioName[];
}

/** A message to queue together with a state change. */
export interface AlertMessage {
  /** Text to send. */
  text: string;
  /** Run that caused the message. */
  runId?: string;
  /** Time of the change, ISO. */
  at: string;
}

/** Storage of runs, alert state and small values. */
export interface History {
  /**
   * Gives the number of the next run of a scenario.
   * @param scenario Scenario whose runs are counted.
   * @returns Highest number among the rows except skipped overlaps, plus 1; 1 when there are none.
   */
  nextSequence(scenario: ScenarioName): number;
  /**
   * Records a run that has started.
   * @param start Identity of the run.
   */
  startRun(start: RunStart): void;
  /**
   * Writes the end of a run and its stages in one transaction.
   * @param runId Run that is running.
   * @param outcome How it ended.
   * @throws Error when no run with this id is running.
   */
  finishRun(runId: string, outcome: RunOutcome): void;
  /**
   * Records a tick that started nothing.
   * @param skip What was skipped and why.
   */
  recordSkip(skip: SkipRecord): void;
  /**
   * Ends every run still marked running.
   * @param errorClass Class to give them.
   * @param at Time of the end, ISO.
   * @returns The rows as they are after the change.
   */
  abortRunning(errorClass: 'monitor_restarted', at: string): RunRow[];
  /**
   * Reads one run.
   * @param runId Id of the run to read.
   * @returns The row with its full result, or undefined.
   */
  get(runId: string): RunWithResult | undefined;
  /**
   * Lists runs.
   * @param options Optional scenario and the most rows to return.
   * @returns Rows, newest first.
   */
  list(options: ListOptions): RunRow[];
  /**
   * Finds the newest run that carries a verdict.
   * @param scenario Scenario whose runs are searched.
   * @param options `aborts` also counts an abort that is not a stop or restart of the monitor; `warmup: false` leaves out the warmup skip.
   * @returns The row, or undefined when no run has a verdict.
   */
  lastVerdict(scenario: ScenarioName, options?: VerdictOptions): RunRow | undefined;
  /**
   * Computes statistics.
   * @param now End of the windows.
   * @param scenarios Scenarios to report, in order.
   * @returns One entry per scenario.
   */
  stats(now: Date, scenarios: readonly ScenarioName[]): ScenarioStats[];
  /**
   * Marks that the sweep found the event of a failed run.
   * @param runId Run whose event was found.
   * @param at Time of the find, ISO.
   * @param delayMs Time from the start of the run.
   * @returns True when the mark was written.
   */
  markLateEvent(runId: string, at: string, delayMs: number): boolean;
  /**
   * Records a notification that came after the run ended.
   * The first one of a run is `late`; a channel that already has `latencyMs` in the result, or the late channel again, is a `duplicate`, written once.
   * @param runId Run the POST belongs to.
   * @param channel Channel of the POST.
   * @param at Time of the POST, ISO.
   * @returns Which mark was written, undefined when none.
   */
  markLateNotification(runId: string, channel: LateKind, at: string): 'duplicate' | 'late' | undefined;
  /**
   * Reads the alert state of a scenario.
   * @param scenario Scenario whose state is read.
   * @returns State, or undefined when none is stored.
   */
  alertState(scenario: ScenarioName): AlertStateRow | undefined;
  /**
   * Writes the alert state and queues a message in one transaction.
   * @param state New state.
   * @param message Message to queue.
   */
  saveAlert(state: AlertStateRow, message?: AlertMessage): void;
  /**
   * Writes to the alert tables as `saveAlert` does and takes the write back, to find out whether they accept writes.
   * @param at Time stamped on the probe row, ISO.
   */
  probeAlertStorage(at: string): void;
  /**
   * Lists alerts due for delivery.
   * @param now Current time, ISO.
   * @param limit Most rows to return.
   * @returns Unsent, undropped rows with `nextAttemptAt` up to `now`, oldest first.
   */
  pendingAlerts(now: string, limit: number): OutboxRow[];
  /**
   * Records a delivery attempt and counts it.
   * @param id Row id.
   * @param update What came of it.
   */
  alertAttempt(id: number, update: AlertAttempt): void;
  /**
   * Finds the oldest message that is neither sent nor dropped.
   * @returns Its `createdAt`, or undefined when the queue is empty.
   */
  oldestUnsentAlert(): string | undefined;
  /**
   * Reads a stored value.
   * @param key Key the value is kept under.
   * @returns The value, or undefined.
   */
  getKv(key: string): string | undefined;
  /**
   * Stores a value.
   * @param key Key to keep the value under.
   * @param value Text to keep under the key.
   */
  setKv(key: string, value: string): void;
  /**
   * Reads a key and writes the value `decide` returns, in one immediate transaction.
   * @param key Key in `kv`.
   * @param decide Gets the current value; returns the value to write, `null` to delete the key, or undefined to leave it.
   * @returns The value before the call.
   */
  updateKv(key: string, decide: (current: string | undefined) => string | null | undefined): string | undefined;
  /**
   * Removes a stored value.
   * @param key Key the value is kept under.
   */
  deleteKv(key: string): void;
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

/** A row as `node:sqlite` returns it. */
type SqlRow = Record<string, unknown>;

/**
 * Reads an optional text column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The text, or undefined for NULL.
 */
function text(row: SqlRow, name: string): string | undefined {
  const value = row[name];

  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads an optional integer column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The number, or undefined for NULL.
 */
function num(row: SqlRow, name: string): number | undefined {
  const value = row[name];

  return typeof value === 'number' ? value : undefined;
}

/**
 * Reads a required text column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The text, empty when the column is NULL.
 */
function required(row: SqlRow, name: string): string {
  return text(row, name) ?? '';
}

/**
 * Parses a JSON list of degradation codes.
 * @param value Column value.
 * @returns The codes, empty for anything unreadable.
 */
function codes(value: string | undefined): DegradedCode[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;

    return Array.isArray(parsed) ? parsed as DegradedCode[] : [];
  } catch {
    return [];
  }
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
 * Drops the keys whose value is undefined, so rows compare cleanly.
 * @param row Object with optional fields.
 * @returns The same object without undefined fields.
 */
function compact<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}

/**
 * Creates the history over an open database.
 * @param db Database from `openDatabase`.
 * @returns History bound to it.
 */
export function createHistory(db: DatabaseSync): History {
  const transaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const value = body();

      db.exec('COMMIT');

      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const all = (sql: string, ...params: SQLInputValue[]): SqlRow[] => db.prepare(sql).all(...params);
  const one = (sql: string, ...params: SQLInputValue[]): SqlRow | undefined => db.prepare(sql).get(...params);
  const run = (sql: string, ...params: SQLInputValue[]): number => Number(db.prepare(sql).run(...params).changes);

  const stagesOf = (pk: number): StageRow[] => all('SELECT name, status, duration_ms, error_class, culprit FROM stages WHERE run_pk = ? ORDER BY position', pk)
    .map(row => compact({ name: required(row, 'name') as StageName,
      status: required(row, 'status') as StageRow['status'],
      durationMs: num(row, 'duration_ms') ?? 0,
      errorClass: text(row, 'error_class') as ErrorClass | undefined,
      culprit: text(row, 'culprit') as Culprit | undefined }));

  const toRow = (row: SqlRow): RunRow => compact<RunRow>({
    id: num(row, 'id') ?? 0,
    runId: required(row, 'run_id'),
    scenario: required(row, 'scenario') as ScenarioName,
    sequence: num(row, 'sequence') ?? 0,
    trigger: required(row, 'trigger') as RunTrigger,
    status: required(row, 'status') as RunStatus,
    startedAt: required(row, 'started_at'),
    finishedAt: text(row, 'finished_at'),
    durationMs: num(row, 'duration_ms'),
    eventLatencyMs: num(row, 'event_latency_ms'),
    failedStage: text(row, 'failed_stage') as StageName | undefined,
    errorClass: text(row, 'error_class') as ErrorClass | undefined,
    culprit: text(row, 'culprit') as Culprit | undefined,
    message: text(row, 'message'),
    skipReason: text(row, 'skip_reason') as SkipReason | undefined,
    degraded: codes(text(row, 'degraded')),
    lateEventFoundAt: text(row, 'late_event_found_at'),
    lateEventDelayMs: num(row, 'late_event_delay_ms'),
    lateNotificationAt: text(row, 'late_notification_at'),
    lateNotificationChannel: text(row, 'late_notification_channel') as LateKind | undefined,
    lateDuplicateNotificationAt: text(row, 'late_duplicate_notification_at'),
    stages: stagesOf(num(row, 'id') ?? 0),
  });

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

  const nextSequence: History['nextSequence'] = (scenario) => {
    const row = one('SELECT MAX(sequence) AS top FROM runs WHERE scenario = ? AND NOT (status = \'skipped\' AND skip_reason = \'overlap\')', scenario);

    return (num(row ?? {}, 'top') ?? 0) + 1;
  };

  const startRun: History['startRun'] = (start) => {
    run('INSERT INTO runs (run_id, scenario, sequence, trigger, status, started_at) VALUES (?, ?, ?, ?, \'running\', ?)',
      start.runId, start.scenario, start.sequence, start.trigger, start.startedAt);
  };

  const finishRun: History['finishRun'] = (runId, outcome) => {
    transaction(() => {
      const row = one('SELECT id FROM runs WHERE run_id = ? AND status = \'running\'', runId);
      const pk = num(row ?? {}, 'id');

      if (pk === undefined) {
        throw new Error(`Run ${runId} is not running or unknown`);
      }

      const { result } = outcome;

      run('UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, event_latency_ms = ?, failed_stage = ?, error_class = ?, culprit = ?, message = ?, skip_reason = ?, degraded = ?, result_json = ? WHERE id = ?',
        outcome.status, outcome.finishedAt, outcome.durationMs, result?.eventLatencyMs ?? null, outcome.failedStage ?? null,
        outcome.errorClass ?? null, outcome.culprit ?? null, outcome.message ?? null, outcome.skipReason ?? null,
        JSON.stringify(outcome.degraded), result === undefined ? null : JSON.stringify(result), pk);

      for (const [position, stage] of (result?.stages ?? []).entries()) {
        run('INSERT INTO stages (run_pk, position, name, status, duration_ms, error_class, culprit) VALUES (?, ?, ?, ?, ?, ?, ?)',
          pk, position, stage.name, stage.status, stage.durationMs, stage.errorClass ?? null, stage.culprit ?? null);
      }
    });
  };

  const recordSkip: History['recordSkip'] = (skip) => {
    run('INSERT INTO runs (run_id, scenario, sequence, trigger, status, started_at, finished_at, duration_ms, skip_reason) VALUES (?, ?, ?, ?, \'skipped\', ?, ?, 0, ?)',
      skip.runId, skip.scenario, skip.sequence, skip.trigger, skip.at, skip.at, skip.reason);
  };

  const abortRunning: History['abortRunning'] = (errorClass, at) => {
    const message = new CheckError(errorClass).message;

    return transaction(() => {
      const rows = all('SELECT id, started_at FROM runs WHERE status = \'running\'');

      for (const row of rows) {
        const duration = Math.max(0, Date.parse(at) - Date.parse(required(row, 'started_at')));

        run('UPDATE runs SET status = \'aborted\', finished_at = ?, duration_ms = ?, error_class = ?, culprit = ?, message = ? WHERE id = ?',
          at, Number.isNaN(duration) ? 0 : duration, errorClass, CULPRIT_OF[errorClass], message, num(row, 'id') ?? 0);
      }

      return rows.map(row => toRow(one('SELECT * FROM runs WHERE id = ?', num(row, 'id') ?? 0) ?? row));
    });
  };

  const get: History['get'] = (runId) => {
    const row = one('SELECT * FROM runs WHERE run_id = ?', runId);

    if (row === undefined) {
      return undefined;
    }

    const json = text(row, 'result_json');

    return json === undefined
      ? toRow(row)
      : { ...toRow(row),
          result: JSON.parse(json) as RunResult };
  };

  const list: History['list'] = (options) => {
    const except = options.exceptScenarios ?? [];
    const filters = [
      ...options.scenario === undefined ? [] : ['scenario = ?'],
      ...except.length === 0 ? [] : [`scenario NOT IN (${except.map(() => '?').join(', ')})`],
    ];
    const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;
    const params: SQLInputValue[] = [...options.scenario === undefined ? [] : [options.scenario], ...except, options.limit];

    return all(`SELECT * FROM runs${where} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params).map(toRow);
  };

  const lastVerdict: History['lastVerdict'] = (scenario, options = {}) => {
    const rows = db.prepare('SELECT * FROM runs WHERE scenario = ? AND status != \'running\' ORDER BY started_at DESC, id DESC').iterate(scenario);

    for (const row of rows) {
      const errorClass = text(row, 'error_class') as ErrorClass | undefined;
      const skipReason = text(row, 'skip_reason') as SkipReason | undefined;

      if (isVerdict({ status: required(row, 'status') as RunStatus,
        ...errorClass === undefined ? {} : { errorClass },
        ...skipReason === undefined ? {} : { skipReason } }, options)) {
        return toRow(row);
      }
    }

    return undefined;
  };

  const stats: History['stats'] = (now, scenarios) => {
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

  const markLateEvent: History['markLateEvent'] = (runId, at, delayMs) => {
    return run('UPDATE runs SET late_event_found_at = ?, late_event_delay_ms = ? WHERE run_id = ? AND status = \'failed\' AND late_event_found_at IS NULL', at, delayMs, runId) > 0;
  };

  const markLateNotification: History['markLateNotification'] = (runId, channel, at) => {
    return transaction(() => {
      const row = one('SELECT late_notification_at, late_notification_channel, late_duplicate_notification_at, result_json FROM runs WHERE run_id = ?', runId);

      if (row === undefined) {
        return undefined;
      }

      const json = text(row, 'result_json');
      const result = json === undefined ? undefined : JSON.parse(json) as RunResult;
      const seen = result?.notification?.[channel]?.latencyMs !== undefined;

      if (text(row, 'late_notification_at') === undefined && !seen) {
        run('UPDATE runs SET late_notification_at = ?, late_notification_channel = ? WHERE run_id = ?', at, channel, runId);

        return 'late';
      }

      if ((seen || text(row, 'late_notification_channel') === channel) && text(row, 'late_duplicate_notification_at') === undefined) {
        run('UPDATE runs SET late_duplicate_notification_at = ? WHERE run_id = ?', at, runId);

        return 'duplicate';
      }

      return undefined;
    });
  };

  const alertState: History['alertState'] = (scenario) => {
    const row = one('SELECT * FROM alert_state WHERE scenario = ?', scenario);

    return row === undefined
      ? undefined
      : compact<AlertStateRow>({
          scenario,
          state: required(row, 'state') as AlertLevelState,
          failureStreak: num(row, 'failure_streak') ?? 0,
          lastClass: text(row, 'last_class'),
          lastStage: text(row, 'last_stage'),
          lastRunId: text(row, 'last_run_id'),
          episodeStartedAt: text(row, 'episode_started_at'),
          episodeFailures: num(row, 'episode_failures') ?? 0,
          degraded: codes(text(row, 'degraded')),
          updatedAt: required(row, 'updated_at'),
        });
  };

  const saveAlert: History['saveAlert'] = (state, message) => {
    transaction(() => {
      run('INSERT OR REPLACE INTO alert_state (scenario, state, failure_streak, last_class, last_stage, last_run_id, episode_started_at, episode_failures, degraded, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        state.scenario, state.state, state.failureStreak, state.lastClass ?? null, state.lastStage ?? null, state.lastRunId ?? null,
        state.episodeStartedAt ?? null, state.episodeFailures, JSON.stringify(state.degraded), state.updatedAt);

      if (message !== undefined) {
        run('INSERT INTO alert_outbox (scenario, run_id, text, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)',
          state.scenario, message.runId ?? null, message.text, message.at, message.at);
      }
    });
  };

  const probeAlertStorage: History['probeAlertStorage'] = (at) => {
    transaction(() => {
      run('INSERT INTO alert_outbox (scenario, run_id, text, created_at, next_attempt_at) VALUES (\'probe\', NULL, \'probe\', ?, ?)', at, at);
      run('DELETE FROM alert_outbox WHERE id = last_insert_rowid()');
    });
  };

  const pendingAlerts: History['pendingAlerts'] = (now, limit) => {
    return all('SELECT * FROM alert_outbox WHERE sent_at IS NULL AND dropped_at IS NULL AND next_attempt_at <= ? ORDER BY created_at, id LIMIT ?', now, limit)
      .map(row => compact<OutboxRow>({ id: num(row, 'id') ?? 0,
        scenario: required(row, 'scenario') as ScenarioName,
        runId: text(row, 'run_id'),
        text: required(row, 'text'),
        createdAt: required(row, 'created_at'),
        attempts: num(row, 'attempts') ?? 0,
        nextAttemptAt: required(row, 'next_attempt_at') }));
  };

  const alertAttempt: History['alertAttempt'] = (id, update) => {
    run('UPDATE alert_outbox SET attempts = attempts + 1, sent_at = COALESCE(?, sent_at), next_attempt_at = COALESCE(?, next_attempt_at), dropped_at = COALESCE(?, dropped_at), last_error = COALESCE(?, last_error) WHERE id = ?',
      update.sentAt ?? null, update.nextAttemptAt ?? null, update.droppedAt ?? null, update.error ?? null, id);
  };

  const oldestUnsentAlert: History['oldestUnsentAlert'] = () => {
    return text(one('SELECT MIN(created_at) AS oldest FROM alert_outbox WHERE sent_at IS NULL AND dropped_at IS NULL') ?? {}, 'oldest');
  };

  const getKv: History['getKv'] = (key) => {
    return text(one('SELECT value FROM kv WHERE key = ?', key) ?? {}, 'value');
  };

  const setKv: History['setKv'] = (key, value) => {
    run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
  };

  const deleteKv: History['deleteKv'] = (key) => {
    run('DELETE FROM kv WHERE key = ?', key);
  };

  const updateKv: History['updateKv'] = (key, decide) => {
    return transaction(() => {
      const current = getKv(key);
      const next = decide(current);

      if (next === null) {
        deleteKv(key);
      } else if (next !== undefined) {
        setKv(key, next);
      }

      return current;
    });
  };

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
    nextSequence,
    startRun,
    finishRun,
    recordSkip,
    abortRunning,
    get,
    list,
    lastVerdict,
    stats,
    markLateEvent,
    markLateNotification,
    alertState,
    saveAlert,
    probeAlertStorage,
    pendingAlerts,
    alertAttempt,
    oldestUnsentAlert,
    getKv,
    setKv,
    updateKv,
    deleteKv,
    prune,
    close,
  };
}
