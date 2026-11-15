import type { FoundEvent, HawkApi } from '../clients/hawk-api.js';
import type { Config } from '../config/load.js';
import type { Logger } from '../log/logger.js';
import { buildTitle } from '../scenarios/send-and-receive/plan.js';
import { SCENARIO_NAMES } from '../scenarios/names.js';
import type { History } from '../storage/history.js';
import type { Clock } from '../time/clock.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const TIMEOUT_FACTOR = 4;
const FIRST_PASS_DELAY_MS = 300_000;
const RUN_ID_PATTERN = /^[a-z]{16}$/u;

/** What one pass of the sweep did. */
export interface SweepReport {
  /** Events of this instance's search that were looked at. */
  scanned: number;
  /** Events removed. */
  removed: number;
  /** Events left alone: not ours, still in use or too young. */
  skipped: number;
  /** Failed runs that got a mark for an event found late. */
  lateMarked: number;
  /** Searches made. */
  pages: number;
  /** Why the pass ended early. */
  error?: string;
}

/** What the sweep needs from outside. */
export interface SweeperDeps {
  /** Hawk API client. */
  api: HawkApi;
  /** History of the runs. */
  history: History;
  /** Time source and sleeper. */
  clock: Clock;
  /** Log. */
  logger: Logger;
  /** Configuration with the project, the instance and the ages. */
  config: Config;
  /** Runs whose events must not be touched because they are going. */
  activeRunIds: () => Set<string>;
  /** Wait before the first pass, 5 minutes by default. */
  firstPassDelayMs?: number;
}

/** What was done with one event. */
interface Handled {
  /** The event was removed. */
  removed: boolean;
  /** Its removal marked the failed run that had not found it. */
  lateMarked: boolean;
}

/** Removes test events that runs left behind. */
export interface Sweeper {
  /**
   * Makes one pass; never throws.
   * @param signal Ends the pass early.
   * @returns What the pass did.
   */
  sweepOnce(signal: AbortSignal): Promise<SweepReport>;
  /** Starts the timer: the first pass after five minutes, then one per `SWEEP_INTERVAL_MS`; nothing when that is 0. */
  start(): void;
  /**
   * Stops the timer and ends the pass in progress.
   * @returns Resolves when nothing is running.
   */
  stop(): Promise<void>;
  /**
   * Counts passes that ended with an error.
   * @returns Number since the start.
   */
  failures(): number;
}

/**
 * Takes the run id out of the title of an event of this instance.
 * @param instanceId Id of this monitor, which the title must carry.
 * @param title Title as the search returned it.
 * @returns The run id when the title is exactly what `buildTitle` makes for one of the scenarios.
 */
function runIdOf(instanceId: string, title: string): string | undefined {
  const prefix = `[e2e:${instanceId}] `;

  if (!title.startsWith(prefix)) {
    return undefined;
  }

  for (const scenario of SCENARIO_NAMES) {
    const suffix = ` ${scenario}`;

    if (title.endsWith(suffix)) {
      const runId = title.slice(prefix.length, title.length - suffix.length);

      if (RUN_ID_PATTERN.test(runId) && buildTitle(instanceId, runId, scenario) === title) {
        return runId;
      }
    }
  }

  return undefined;
}

/**
 * Reads `context.instanceId` of an event.
 * @param context Context as Hawk returns it.
 * @returns The id, or undefined when the context has none.
 */
function contextInstance(context: unknown): unknown {
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>).instanceId
    : undefined;
}

/**
 * Describes a thrown value.
 * @param error Anything thrown.
 * @returns Its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the sweeper.
 * @param deps API, history, clock, logger, configuration and the set of running runs.
 * @returns Sweeper that is not started yet.
 */
export function createSweeper(deps: SweeperDeps): Sweeper {
  const { api, history, clock, logger, config } = deps;
  const { projectId } = config.hawk;
  const { sweepMinAgeMs, sweepIntervalMs } = config.monitoring;
  const stopper = new AbortController();
  let loop: Promise<void> | undefined;
  let failures = 0;

  /**
   * Decides what to do with one event and does it.
   * @param event Event found by the search.
   * @param signal Ends the pass.
   * @returns Whether the event was removed and whether that marked a late event.
   */
  const handle = async (event: FoundEvent, signal: AbortSignal): Promise<Handled> => {
    const left = { removed: false,
      lateMarked: false };
    const runId = runIdOf(config.instanceId, event.title);

    if (runId === undefined || contextInstance(event.context) !== config.instanceId || deps.activeRunIds().has(runId)) {
      return left;
    }

    const nowMs = clock.wallTime().getTime();
    const run = history.get(runId);

    if (run === undefined) {
      if (event.timestamp === undefined || nowMs - event.timestamp < sweepMinAgeMs) {
        return left;
      }
    } else if (run.finishedAt === undefined || nowMs - Date.parse(run.finishedAt) < sweepMinAgeMs) {
      return left;
    }

    const card = await api.eventCard(projectId, event.originalEventId, signal);

    // The event may be gone already, or Hawk may show something other than the search did.
    if (card === null || runIdOf(config.instanceId, card.title) !== runId || contextInstance(card.context) !== config.instanceId) {
      return left;
    }

    if (run === undefined && (card.timestamp === undefined || nowMs - card.timestamp < sweepMinAgeMs)) {
      return left;
    }

    if (!await api.removeEvent(projectId, card.originalEventId, signal)) {
      logger.warn('sweep: Hawk did not remove an event', { runId });

      return left;
    }

    const late = run?.status === 'failed' && run.result?.event === undefined
      && history.markLateEvent(runId, clock.wallTime().toISOString(), nowMs - Date.parse(run.startedAt));

    return { removed: true,
      lateMarked: late === true };
  };

  const sweepOnce = async (outer: AbortSignal): Promise<SweepReport> => {
    const report: SweepReport = { scanned: 0,
      removed: 0,
      skipped: 0,
      lateMarked: 0,
      pages: 0 };
    const timeout = new AbortController();
    const signal = AbortSignal.any([outer, timeout.signal]);

    clock.sleep(config.timeouts.cleanup * TIMEOUT_FACTOR, timeout.signal).then(() => {
      timeout.abort();
    }, () => undefined);

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        signal.throwIfAborted();

        const events = await api.findEvents(projectId, `[e2e:${config.instanceId}]`, signal);
        const removedBefore = report.removed;

        report.pages += 1;

        for (const event of events) {
          signal.throwIfAborted();
          report.scanned += 1;

          const outcome = await handle(event, signal);

          report.removed += outcome.removed ? 1 : 0;
          report.lateMarked += outcome.lateMarked ? 1 : 0;
          report.skipped += outcome.removed ? 0 : 1;
        }

        if (events.length < PAGE_SIZE || report.removed === removedBefore) {
          break;
        }
      }
    } catch (error) {
      report.error = describe(error);
      failures += 1;
      logger.warn('sweep failed', { error: report.error,
        ...report });
    } finally {
      timeout.abort();
    }

    if (report.error === undefined && (report.removed > 0 || report.lateMarked > 0)) {
      logger.info('sweep removed leftover events', { removed: report.removed,
        lateMarked: report.lateMarked });
    }

    return report;
  };

  const start: Sweeper['start'] = () => {
    if (sweepIntervalMs === 0 || loop !== undefined) {
      return;
    }

    loop = (async (): Promise<void> => {
      let pauseMs = deps.firstPassDelayMs ?? FIRST_PASS_DELAY_MS;

      for (;;) {
        try {
          await clock.sleep(pauseMs, stopper.signal);
        } catch {
          return;
        }

        await sweepOnce(stopper.signal);
        pauseMs = sweepIntervalMs;
      }
    })();
  };

  const stop: Sweeper['stop'] = async () => {
    stopper.abort();
    await loop;
  };

  return {
    sweepOnce,
    start,
    stop,
    failures: () => failures,
  };
}
