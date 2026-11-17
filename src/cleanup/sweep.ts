import type { FoundEvent, HawkApi } from '../clients/hawk-api.js';
import type { Config } from '../config/load.js';
import { CheckError } from '../errors/taxonomy.js';
import type { Logger } from '../log/logger.js';
import { buildTitle } from '../scenarios/shared/plan.js';
import { EVENT_SCENARIOS, SENTRY_ENVELOPE } from '../scenarios/names.js';
import { createdProjects } from '../storage/created-projects.js';
import type { History } from '../storage/history.js';
import { pendingProjects } from '../storage/pending-projects.js';
import type { Clock } from '../time/clock.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const TIMEOUT_FACTOR = 4;
const FIRST_PASS_DELAY_MS = 300_000;
const RUN_ID_PATTERN = /^[a-z]{16}$/u;
// The collector puts the type of the exception in front of the value to make the title of an event that came as an envelope.
const SENTRY_PREFIX = 'E2eMonitorCheck: ';

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
  /** What the pass did about the projects of `new-project`; absent when none was recorded. */
  projects?: ProjectsReport;
  /** Why the pass ended early. */
  error?: string;
}

/** What a pass did about the projects `new-project` left behind. */
export interface ProjectsReport {
  /** Projects removed. */
  removed: number;
  /** Recorded projects that Hawk no longer has. */
  gone: number;
  /** Projects left alone: another workspace, another name, too young or still in use. */
  skipped: number;
  /** The first error that stopped the removal of one project; the pass went on with the others. */
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
 * The events of `sentry-envelope` have a second form of the title: the type of the exception and a colon in front.
 * @param instanceId Id of this monitor, which the title must carry.
 * @param title Title as the search returned it.
 * @returns The run id when the title is exactly what `buildTitle` makes for one of the scenarios, in the form that scenario uses.
 */
function runIdOf(instanceId: string, title: string): string | undefined {
  const viaSentry = title.startsWith(SENTRY_PREFIX);
  const plain = viaSentry ? title.slice(SENTRY_PREFIX.length) : title;
  const prefix = `[e2e:${instanceId}] `;

  if (!plain.startsWith(prefix)) {
    return undefined;
  }

  for (const scenario of EVENT_SCENARIOS.filter(name => (name === SENTRY_ENVELOPE) === viaSentry)) {
    const suffix = ` ${scenario}`;

    if (plain.endsWith(suffix)) {
      const runId = plain.slice(prefix.length, plain.length - suffix.length);

      if (RUN_ID_PATTERN.test(runId) && buildTitle(instanceId, runId, scenario) === plain) {
        return runId;
      }
    }
  }

  return undefined;
}

/**
 * Builds the pattern of the name `new-project` gives its projects.
 * @param instanceId Id of this monitor; its characters are matched literally.
 * @returns Pattern with the run id as its first group.
 */
function projectNamePattern(instanceId: string): RegExp {
  return new RegExp(`^\\[e2e:${instanceId.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}\\] new-project (r[a-z]{15})$`, 'u');
}

/**
 * Reads the instance id an event names in its context: `context.instanceId`, or `context.e2e.instanceId` for an event that came as a Sentry envelope.
 * @param context Context as Hawk returns it.
 * @param title Title of the event, which tells the form.
 * @returns The id, or undefined when the context has none.
 */
function contextInstance(context: unknown, title: string): unknown {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return undefined;
  }

  const record = context as Record<string, unknown>;
  const holder = title.startsWith(SENTRY_PREFIX) ? record.e2e : record;

  return typeof holder === 'object' && holder !== null ? (holder as Record<string, unknown>).instanceId : undefined;
}

/**
 * Reads `context.instanceId`, which an event of the Sentry path does not have unless another source wrote it.
 * @param context Context as Hawk returns it.
 * @returns The id, or undefined when the context has none.
 */
function plainInstance(context: unknown): unknown {
  return typeof context === 'object' && context !== null && !Array.isArray(context) ? (context as Record<string, unknown>).instanceId : undefined;
}

/**
 * Tells whether the context of an event names this instance.
 * An event in the form of the Sentry path may have lost its context, so a title of this instance is enough there
 * unless the context names another instance.
 * @param context Context as Hawk returns it.
 * @param title Title of the event, which tells the form.
 * @param instanceId Id of this monitor.
 * @returns True when the event is of this instance as far as its context says.
 */
function inInstance(context: unknown, title: string, instanceId: string): boolean {
  const named = contextInstance(context, title) ?? plainInstance(context);

  return named === instanceId || (named === undefined && title.startsWith(SENTRY_PREFIX));
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

    if (runId === undefined || !inInstance(event.context, event.title, config.instanceId) || deps.activeRunIds().has(runId)) {
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
    if (card === null || runIdOf(config.instanceId, card.title) !== runId || !inInstance(card.context, card.title, config.instanceId)) {
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

  /**
   * Removes the recorded projects of `new-project` that a run left behind.
   * Hawk checks no rights on `removeProject`, so a project goes only when every check says it is ours:
   * it was recorded by this monitor, sits in the workspace of the monitored project, is not that project,
   * carries the exact name of this instance, belongs to no running run and is old enough.
   * A run whose project id was never learned is found by the exact name instead, under the same checks.
   * @param signal Ends the pass.
   * @returns What was done, undefined when nothing is recorded.
   */
  const sweepProjects = async (signal: AbortSignal): Promise<ProjectsReport | undefined> => {
    const record = createdProjects(history);
    const pending = pendingProjects(history);
    const candidates = record.ids();
    const nowMs = clock.wallTime().getTime();
    const lookups = pending.list().filter(entry => !deps.activeRunIds().has(entry.runId) && nowMs - Date.parse(entry.at) >= sweepMinAgeMs);

    if (candidates.length === 0 && lookups.length === 0) {
      return undefined;
    }

    // A project without a known id can be found only in the full list.
    const lists = await api.workspaceProjects(lookups.length > 0 ? [] : [projectId, ...candidates], signal);
    const home = lists.find(list => list.projects.some(project => project.id === projectId));

    if (home === undefined) {
      throw new CheckError('api_error', { detail: 'none of the workspaces the API listed holds the monitored project, so no project is removed' });
    }

    const pattern = projectNamePattern(config.instanceId);
    const report: ProjectsReport = { removed: 0,
      gone: 0,
      skipped: 0 };
    // One project that cannot be removed must not keep the others from it.
    const removing = async (remove: () => Promise<boolean>, runId: string): Promise<boolean> => {
      try {
        const done = await remove();

        if (!done) {
          logger.warn('sweep: Hawk did not remove a project', { runId });
        }

        return done;
      } catch (error) {
        signal.throwIfAborted();
        report.error ??= describe(error);
        logger.warn('sweep: a project could not be removed', { runId,
          error: describe(error) });

        return false;
      }
    };

    for (const id of candidates) {
      signal.throwIfAborted();

      const holder = lists.find(list => list.projects.some(project => project.id === id));

      if (holder === undefined) {
        record.forget(id);
        report.gone += 1;

        continue;
      }

      const project = holder.projects.find(item => item.id === id);
      const runId = project === undefined ? undefined : pattern.exec(project.name)?.[1];

      if (project === undefined || holder.workspaceId !== home.workspaceId || id === projectId || runId === undefined
        || deps.activeRunIds().has(runId) || clock.wallTime().getTime() - project.createdAtMs < sweepMinAgeMs) {
        report.skipped += 1;

        continue;
      }

      if (await removing(() => api.removeProject(id, signal), runId)) {
        record.forget(id);
        report.removed += 1;
      } else {
        report.skipped += 1;
      }
    }

    for (const { runId } of lookups) {
      signal.throwIfAborted();

      const name = `[e2e:${config.instanceId}] new-project ${runId}`;
      const project = home.projects.find(item => item.name === name);

      if (project === undefined) {
        pending.drop(runId);
        report.gone += 1;
      } else if (project.id === projectId) {
        // Nothing here may ever remove it, so the entry has no use.
        pending.drop(runId);
        report.skipped += 1;
      } else if (clock.wallTime().getTime() - project.createdAtMs < sweepMinAgeMs) {
        report.skipped += 1;
      } else if (await removing(() => api.removeProject(project.id, signal), runId)) {
        record.forget(project.id);
        pending.drop(runId);
        report.removed += 1;
      } else {
        report.skipped += 1;
      }
    }

    return report;
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

        // Hawk parses the search as a regex, so no brackets; the title prefix is checked on the results.
        const events = await api.findEvents(projectId, `e2e:${config.instanceId}`, signal);
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

      const projects = await sweepProjects(signal);

      if (projects !== undefined) {
        report.projects = projects;

        if (projects.error !== undefined) {
          report.error = projects.error;
          failures += 1;
          logger.warn('sweep failed', { ...report });
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

    if (report.error === undefined && report.projects !== undefined && report.projects.removed + report.projects.gone > 0) {
      logger.info('sweep dealt with leftover projects', { ...report.projects });
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
