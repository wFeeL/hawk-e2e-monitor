import type { SQLInputValue } from 'node:sqlite';
import type { RunResult, StageName } from '../engine/result.js';
import { CheckError, CULPRIT_OF } from '../errors/taxonomy.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';
import type { LateKind } from '../notifications/types.js';
import type { ScenarioName } from '../scenarios/names.js';
import { isVerdict } from './outcome.js';
import type { VerdictOptions } from './outcome.js';
import { codes, compact, num, required, text } from './rows.js';
import type { SqlRow } from './rows.js';
import type { Sql } from './sql.js';
import type { ListOptions, RunOutcome, RunRow, RunStart, RunStatus, RunTrigger, RunWithResult, SkipReason, SkipRecord, StageRow } from './types.js';

/** Runs, their stages and the marks the sweep and the receiver add later. */
export interface RunStore {
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
}

/**
 * Creates the run store over a database.
 * @param sql Helpers bound to the database.
 * @returns Store bound to it.
 */
export function createRunStore(sql: Sql): RunStore {
  const { transaction, all, one, run, iterate } = sql;

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

  const nextSequence: RunStore['nextSequence'] = (scenario) => {
    const row = one('SELECT MAX(sequence) AS top FROM runs WHERE scenario = ? AND NOT (status = \'skipped\' AND skip_reason = \'overlap\')', scenario);

    return (num(row ?? {}, 'top') ?? 0) + 1;
  };

  const startRun: RunStore['startRun'] = (start) => {
    run('INSERT INTO runs (run_id, scenario, sequence, trigger, status, started_at) VALUES (?, ?, ?, ?, \'running\', ?)',
      start.runId, start.scenario, start.sequence, start.trigger, start.startedAt);
  };

  const finishRun: RunStore['finishRun'] = (runId, outcome) => {
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

  const recordSkip: RunStore['recordSkip'] = (skip) => {
    run('INSERT INTO runs (run_id, scenario, sequence, trigger, status, started_at, finished_at, duration_ms, skip_reason) VALUES (?, ?, ?, ?, \'skipped\', ?, ?, 0, ?)',
      skip.runId, skip.scenario, skip.sequence, skip.trigger, skip.at, skip.at, skip.reason);
  };

  const abortRunning: RunStore['abortRunning'] = (errorClass, at) => {
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

  const get: RunStore['get'] = (runId) => {
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

  const list: RunStore['list'] = (options) => {
    const except = options.exceptScenarios ?? [];
    const filters = [
      ...options.scenario === undefined ? [] : ['scenario = ?'],
      ...except.length === 0 ? [] : [`scenario NOT IN (${except.map(() => '?').join(', ')})`],
    ];
    const where = filters.length === 0 ? '' : ` WHERE ${filters.join(' AND ')}`;
    const params: SQLInputValue[] = [...options.scenario === undefined ? [] : [options.scenario], ...except, options.limit];

    return all(`SELECT * FROM runs${where} ORDER BY started_at DESC, id DESC LIMIT ?`, ...params).map(toRow);
  };

  const lastVerdict: RunStore['lastVerdict'] = (scenario, options = {}) => {
    const rows = iterate('SELECT * FROM runs WHERE scenario = ? AND status != \'running\' ORDER BY started_at DESC, id DESC', scenario);

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

  const markLateEvent: RunStore['markLateEvent'] = (runId, at, delayMs) => {
    return run('UPDATE runs SET late_event_found_at = ?, late_event_delay_ms = ? WHERE run_id = ? AND status = \'failed\' AND late_event_found_at IS NULL', at, delayMs, runId) > 0;
  };

  const markLateNotification: RunStore['markLateNotification'] = (runId, channel, at) => {
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

  return {
    nextSequence,
    startRun,
    finishRun,
    recordSkip,
    abortRunning,
    get,
    list,
    lastVerdict,
    markLateEvent,
    markLateNotification,
  };
}
