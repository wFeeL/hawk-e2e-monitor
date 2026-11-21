import type { ScenarioName } from '../scenarios/names.js';
import { codes, compact, num, required, text } from './rows.js';
import type { SqlRow } from './rows.js';
import type { Sql } from './sql.js';
import type { AlertAttempt, AlertLevelState, AlertMessage, AlertStateRow, OpenPair, OutboxRow } from './types.js';

/** Alert state and the outbox of alerts waiting for delivery. */
export interface AlertStore {
  /**
   * Reads the alert state of a scenario.
   * @param scenario Scenario whose state is read.
   * @returns State, or undefined when none is stored.
   */
  alertState(scenario: ScenarioName): AlertStateRow | undefined;
  /**
   * Reads the alert states of every scenario.
   * @returns All stored states.
   */
  alertStates(): AlertStateRow[];
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
   * Records an answer that rejected the message: counts the attempt and the rejection.
   * @param id Row id.
   * @param nextAttemptAt Earliest next attempt, ISO.
   * @param error Text of the failure.
   */
  alertRejected(id: number, nextAttemptAt: string, error: string): void;
  /**
   * Finds the oldest message that is neither sent nor dropped.
   * @returns Its `createdAt`, or undefined when the queue is empty.
   */
  oldestUnsentAlert(): string | undefined;
}

/**
 * Parses a JSON list column.
 * @param value Column value.
 * @param keep Tells whether an element has the expected shape.
 * @returns The elements that pass `keep`, empty for anything unreadable.
 */
function listOf<T>(value: string | undefined, keep: (item: unknown) => item is T): T[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;

    return Array.isArray(parsed) ? parsed.filter(keep) : [];
  } catch {
    return [];
  }
}

const isOpenPair = (item: unknown): item is OpenPair => typeof item === 'object' && item !== null
  && typeof (item as OpenPair).pair === 'string' && typeof (item as OpenPair).count === 'number';
const isText = (item: unknown): item is string => typeof item === 'string';

/**
 * Creates the alert store over a database.
 * @param sql Helpers bound to the database.
 * @returns Store bound to it.
 */
export function createAlertStore(sql: Sql): AlertStore {
  const { transaction, all, one, run } = sql;

  const stateOf = (row: SqlRow): AlertStateRow => compact<AlertStateRow>({
    scenario: required(row, 'scenario') as ScenarioName,
    state: required(row, 'state') as AlertLevelState,
    failureStreak: num(row, 'failure_streak') ?? 0,
    lastClass: text(row, 'last_class'),
    lastStage: text(row, 'last_stage'),
    lastRunId: text(row, 'last_run_id'),
    episodeStartedAt: text(row, 'episode_started_at'),
    episodeFailures: num(row, 'episode_failures') ?? 0,
    degraded: codes(text(row, 'degraded')),
    open: listOf(text(row, 'open'), isOpenPair),
    announced: num(row, 'announced') !== 0,
    streakStartedAt: text(row, 'streak_started_at'),
    reported: listOf(text(row, 'reported'), isText),
    updatedAt: required(row, 'updated_at'),
  });

  const alertState: AlertStore['alertState'] = (scenario) => {
    const row = one('SELECT * FROM alert_state WHERE scenario = ?', scenario);

    return row === undefined ? undefined : stateOf(row);
  };

  const alertStates: AlertStore['alertStates'] = () => all('SELECT * FROM alert_state ORDER BY scenario').map(stateOf);

  const saveAlert: AlertStore['saveAlert'] = (state, message) => {
    transaction(() => {
      run('INSERT OR REPLACE INTO alert_state (scenario, state, failure_streak, last_class, last_stage, last_run_id, episode_started_at, episode_failures, degraded, updated_at, open, announced, streak_started_at, reported) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        state.scenario, state.state, state.failureStreak, state.lastClass ?? null, state.lastStage ?? null, state.lastRunId ?? null,
        state.episodeStartedAt ?? null, state.episodeFailures, JSON.stringify(state.degraded), state.updatedAt,
        JSON.stringify(state.open), state.announced ? 1 : 0, state.streakStartedAt ?? null, JSON.stringify(state.reported));

      if (message !== undefined) {
        run('INSERT INTO alert_outbox (scenario, run_id, text, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?)',
          state.scenario, message.runId ?? null, message.text, message.at, message.at);
      }
    });
  };

  const probeAlertStorage: AlertStore['probeAlertStorage'] = (at) => {
    transaction(() => {
      run('INSERT INTO alert_outbox (scenario, run_id, text, created_at, next_attempt_at) VALUES (\'probe\', NULL, \'probe\', ?, ?)', at, at);
      run('DELETE FROM alert_outbox WHERE id = last_insert_rowid()');
    });
  };

  const pendingAlerts: AlertStore['pendingAlerts'] = (now, limit) => {
    return all('SELECT * FROM alert_outbox WHERE sent_at IS NULL AND dropped_at IS NULL AND next_attempt_at <= ? ORDER BY created_at, id LIMIT ?', now, limit)
      .map(row => compact<OutboxRow>({ id: num(row, 'id') ?? 0,
        scenario: required(row, 'scenario') as ScenarioName,
        runId: text(row, 'run_id'),
        text: required(row, 'text'),
        createdAt: required(row, 'created_at'),
        attempts: num(row, 'attempts') ?? 0,
        rejections: num(row, 'rejections') ?? 0,
        nextAttemptAt: required(row, 'next_attempt_at') }));
  };

  const alertAttempt: AlertStore['alertAttempt'] = (id, update) => {
    run('UPDATE alert_outbox SET attempts = attempts + 1, sent_at = COALESCE(?, sent_at), next_attempt_at = COALESCE(?, next_attempt_at), dropped_at = COALESCE(?, dropped_at), last_error = COALESCE(?, last_error) WHERE id = ?',
      update.sentAt ?? null, update.nextAttemptAt ?? null, update.droppedAt ?? null, update.error ?? null, id);
  };

  const alertRejected: AlertStore['alertRejected'] = (id, nextAttemptAt, error) => {
    run('UPDATE alert_outbox SET attempts = attempts + 1, rejections = rejections + 1, next_attempt_at = ?, last_error = ? WHERE id = ?',
      nextAttemptAt, error, id);
  };

  const oldestUnsentAlert: AlertStore['oldestUnsentAlert'] = () => {
    return text(one('SELECT MIN(created_at) AS oldest FROM alert_outbox WHERE sent_at IS NULL AND dropped_at IS NULL') ?? {}, 'oldest');
  };

  return {
    alertState,
    alertStates,
    saveAlert,
    probeAlertStorage,
    pendingAlerts,
    alertAttempt,
    alertRejected,
    oldestUnsentAlert,
  };
}
