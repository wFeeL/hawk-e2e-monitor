import type { Config } from '../config/load.js';
import type { RunResult } from '../engine/result.js';
import type { Redactor } from '../errors/redact.js';
import { isCheckError } from '../errors/taxonomy.js';
import type { Logger } from '../log/logger.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { AlertStateRow, History } from '../storage/history.js';
import type { RunRow } from '../storage/types.js';
import type { Clock } from '../time/clock.js';
import { sendNotify } from './notify.js';
import { decideAlert } from './state.js';
import type { AlertKind } from './state.js';
import { alertText, plainAlertText, storageFailingText } from './text.js';
import type { AlertTextInput } from './text.js';
import { MS_PER_DAY } from '../time/units.js';
import { scenarioSettings } from '../config/scenario.js';

/** Age of the oldest undelivered alert after which the alerts count as not delivered. */
export const ALERT_BACKLOG_LIMIT_MS = 1_800_000;
const FLUSH_BATCH = 50;
const MAX_RETRY_PAUSE_MS = 600_000;
const REJECTED_LOG_EVERY = 3;

/** What the alerter needs from outside. */
export interface AlerterDeps {
  /** Store of the alert state and the queue. */
  history: History;
  /** Log of the alerter. */
  logger: Logger;
  /** Time source and sleeper. */
  clock: Clock;
  /** Masks secrets in every text. */
  redact: Redactor;
  /** Configuration: instance id, HTTP time limit and the `monitoring` settings. */
  config: Config;
  /** Replaces `sendNotify`, for tests. */
  send?: typeof sendNotify;
}

/** What a `flush` did. */
export interface FlushResult {
  /** Messages delivered, or logged when there is no URL. */
  sent: number;
  /** Messages whose delivery failed. */
  failed: number;
}

/** Health figures for `/stats` and `/readyz`. */
export interface AlerterHealth {
  /** Age of the oldest message that is neither sent nor dropped; null when none waits. */
  backlogAgeMs: number | null;
  /** Rejections by codex.bot in a row. */
  rejectedInRow: number;
  /** True from a failed storage call until the next successful write. */
  storageFailing: boolean;
}

/** Turns finished runs into alerts and delivers them. */
export interface Alerter {
  /**
   * Decides what a finished run means for the alert state and queues the message; never throws.
   * When the storage fails the state is kept in memory and the message goes out directly.
   * @param row Finished run.
   * @param result Full result of the run, when there is one.
   * @returns Kind of the message produced, if any.
   */
  onRunFinished(row: RunRow, result: RunResult | undefined): AlertKind | undefined;
  /**
   * Sends the queued messages that are due, in order, and stops at the first failure; never rejects.
   * @param signal Cancels the sending.
   * @returns How many messages were sent and how many failed.
   */
  flush(signal: AbortSignal): Promise<FlushResult>;
  /** Starts the retry timer; after this, a queued message is also flushed at once. */
  start(): void;
  /**
   * Stops the timer and waits for the sending in progress.
   * @returns Resolves when nothing is in flight.
   */
  stop(): Promise<void>;
  /**
   * Reads the health figures.
   * @returns Backlog age, rejections in a row and the storage flag.
   */
  health(): AlerterHealth;
  /**
   * Counts failed storage calls.
   * @returns Number since the start.
   */
  failures(): number;
}

/**
 * Describes a thrown value for a log or a stored error text.
 * @param error Anything thrown.
 * @returns Its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the alerter.
 * @param deps History, logger, clock, redactor, configuration and an optional sender.
 * @returns Alerter that is not started yet.
 */
export function createAlerter(deps: AlerterDeps): Alerter {
  const { history, logger, clock, redact, config } = deps;
  const send = deps.send ?? sendNotify;
  const { monitoring } = config;
  const stopper = new AbortController();
  // The last state per scenario keeps decisions right while the storage is down.
  const memory = new Map<ScenarioName, AlertStateRow>();
  let started = false;
  let loop: Promise<void> | undefined;
  let flushing: Promise<FlushResult> | undefined;
  let again = false;
  let direct: Promise<void> = Promise.resolve();
  let rejectedInRow = 0;
  let storageFailing = false;
  let storageNoticeSent = false;
  let storageFailures = 0;

  const nowIso = (): string => clock.wallTime().toISOString();
  // A health probe only reads; it raises the flag but is not a failed write, so it stays out of the counter.
  const storageFailed = (error: unknown, what: string, counted = true): void => {
    storageFailing = true;

    if (counted) {
      storageFailures += 1;
    }

    logger.error(`alert storage failed: ${what}`, { error });
  };
  const storageWorked = (): void => {
    storageFailing = false;
    storageNoticeSent = false;
  };

  /**
   * Delivers a text now, without the queue; used while the storage is down.
   * @param text HTML text.
   * @param scenario Scenario for the log when there is no URL.
   * @returns Resolves when the attempt ended; never rejects.
   */
  const sendDirect = async (text: string, scenario: ScenarioName): Promise<void> => {
    try {
      if (monitoring.alertNotifyUrl === undefined) {
        logger.warn('alert', { scenario,
          text });
      } else {
        await send(monitoring.alertNotifyUrl, text, { httpTimeoutMs: config.httpTimeoutMs,
          clock }, stopper.signal);
      }
    } catch (error) {
      logger.error('alert could not be sent directly', { error: redact(describe(error)) });
    }
  };

  const sendAfterStorageFailure = (text: string, scenario: ScenarioName, error: unknown): void => {
    const notice = storageNoticeSent
      ? undefined
      : storageFailingText(config.instanceId, describe(error), redact);

    storageNoticeSent = true;
    direct = direct.then(async () => {
      if (notice !== undefined) {
        await sendDirect(notice, scenario);
      }

      await sendDirect(text, scenario);
    });
  };

  const deliver = async (signal: AbortSignal): Promise<FlushResult> => {
    const result = { sent: 0,
      failed: 0 };
    const now = nowIso();
    const rows = history.pendingAlerts(now, FLUSH_BATCH);
    const oldest = history.oldestUnsentAlert();

    // A newer message must not overtake an older one that waits for its retry time.
    if (rows[0] !== undefined && oldest !== undefined && rows[0].createdAt > oldest) {
      return result;
    }

    for (const row of rows) {
      if (Date.parse(now) - Date.parse(row.createdAt) > MS_PER_DAY) {
        history.alertAttempt(row.id, { droppedAt: now,
          error: 'dropped after 24 hours' });
        logger.error('alert dropped', { scenario: row.scenario,
          runId: row.runId,
          createdAt: row.createdAt });
      } else if (monitoring.alertNotifyUrl === undefined) {
        logger.warn('alert', { scenario: row.scenario,
          text: row.text });
        history.alertAttempt(row.id, { sentAt: now });
        result.sent += 1;
      } else {
        try {
          await send(monitoring.alertNotifyUrl, row.text, { httpTimeoutMs: config.httpTimeoutMs,
            clock }, signal);
          history.alertAttempt(row.id, { sentAt: nowIso() });
          rejectedInRow = 0;
          result.sent += 1;
        } catch (error) {
          const pause = Math.min(monitoring.alertRetryMs * 2 ** row.attempts, MAX_RETRY_PAUSE_MS);

          history.alertAttempt(row.id, { nextAttemptAt: new Date(Date.parse(now) + pause).toISOString(),
            error: redact(describe(error)) });
          rejectedInRow = isCheckError(error) && error.errorClass === 'alert_rejected' ? rejectedInRow + 1 : 0;

          if (rejectedInRow > 0 && rejectedInRow % REJECTED_LOG_EVERY === 0) {
            logger.error('codex.bot rejected 3 alerts in a row; check ALERT_NOTIFY_URL', { rejectedInRow });
          }

          logger.warn('alert delivery failed', { scenario: row.scenario,
            error: redact(describe(error)),
            retryInMs: pause });
          result.failed += 1;

          break;
        }
      }
    }

    return result;
  };

  const flush = async (signal: AbortSignal): Promise<FlushResult> => {
    if (flushing !== undefined) {
      again = true;

      return flushing;
    }

    const total = { sent: 0,
      failed: 0 };

    flushing = (async (): Promise<FlushResult> => {
      try {
        do {
          again = false;

          const part = await deliver(signal);

          total.sent += part.sent;
          total.failed += part.failed;
        } while (again && !signal.aborted);
      } catch (error) {
        storageFailed(error, 'flush');
      }

      return total;
    })();

    try {
      return await flushing;
    } finally {
      flushing = undefined;
    }
  };

  const requestFlush = (): void => {
    if (started) {
      flush(stopper.signal).catch((error: unknown) => {
        logger.error('alert flush failed', { error });
      });
    }
  };

  /**
   * Builds the alert text, or a plain one when the full text cannot be built, so a transition is never left without a message.
   * @param kind Kind of the alert.
   * @param input Everything the full text needs.
   * @returns HTML text.
   */
  const textOf = (kind: AlertKind, input: AlertTextInput): string => {
    try {
      return alertText(input, redact);
    } catch (error) {
      logger.error('alert text could not be built', { error: redact(describe(error)) });

      return plainAlertText(kind, input.scenario, config.instanceId);
    }
  };

  const onRunFinished: Alerter['onRunFinished'] = (row, result) => {
    try {
      const now = nowIso();
      let previous: AlertStateRow | undefined = memory.get(row.scenario);
      let readError: unknown;

      if (previous === undefined) {
        try {
          previous = history.alertState(row.scenario);
        } catch (error) {
          storageFailed(error, 'read');
          readError = error;
        }
      }

      const decision = decideAlert(previous, row, { alertAfterFailures: scenarioSettings(config, row.scenario).alertAfterFailures }, now);
      const { kind } = decision;

      // A state derived without the stored one would hide the real episode from every later run, so it is not kept.
      if (readError === undefined) {
        memory.set(row.scenario, decision.state);
      }

      const text = kind === undefined
        ? undefined
        : textOf(kind, { kind,
            instanceId: config.instanceId,
            scenario: row.scenario,
            row,
            state: decision.state,
            ...result === undefined ? {} : { result },
            now });

      if (readError !== undefined) {
        // Without the stored state nothing can be queued, so the message goes out directly.
        if (text !== undefined) {
          sendAfterStorageFailure(text, row.scenario, readError);
        }

        return kind;
      }

      try {
        if (decision.state !== previous) {
          history.saveAlert(decision.state, text === undefined
            ? undefined
            : { text,
                runId: row.runId,
                at: now });
          // Only a real write proves the storage works; an unchanged state touches nothing.
          storageWorked();
        }
      } catch (error) {
        storageFailed(error, 'save');

        if (text !== undefined) {
          sendAfterStorageFailure(text, row.scenario, error);
        }

        return kind;
      }

      if (kind !== undefined) {
        requestFlush();
      }

      return kind;
    } catch (error) {
      logger.error('alerter failed', { error });

      return undefined;
    }
  };

  const start: Alerter['start'] = () => {
    if (started) {
      return;
    }

    started = true;
    loop = (async (): Promise<void> => {
      for (;;) {
        try {
          await clock.sleep(monitoring.alertRetryMs, stopper.signal);
        } catch {
          return;
        }

        requestFlush();
      }
    })();
  };

  const stop: Alerter['stop'] = async () => {
    stopper.abort();
    await loop;
    await flushing?.catch(() => undefined);
    await direct;
  };

  const health: Alerter['health'] = () => {
    let backlogAgeMs: number | null = null;

    try {
      const oldest = history.oldestUnsentAlert();

      backlogAgeMs = oldest === undefined ? null : Date.parse(nowIso()) - Date.parse(oldest);

      // Runs with an unchanged state write nothing, so after a passing fault only a probe write can clear the flag.
      // The notice flag stays: only a real save ends the episode, so a second notice never goes out within it.
      if (storageFailing) {
        history.probeAlertStorage(nowIso());
        storageFailing = false;
      }
    } catch (error) {
      storageFailed(error, 'health', false);
    }

    return { backlogAgeMs,
      rejectedInRow,
      storageFailing };
  };

  return {
    onRunFinished,
    flush,
    start,
    stop,
    health,
    failures: () => storageFailures,
  };
}
