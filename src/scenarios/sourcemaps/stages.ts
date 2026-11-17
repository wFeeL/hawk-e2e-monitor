import type { CollectorMessage } from '../../clients/collector.js';
import type { EventCard } from '../../clients/hawk-api.js';
import { pollUntil } from '../../engine/poll.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { RunPlan } from '../shared/plan.js';
import { checkEventFields, sendEventShape } from '../send-and-receive/stages.js';
import type { EventShape, ScenarioContext } from '../send-and-receive/stages.js';
import { SOURCE_NAME, expectedSourceCode } from './map.js';
import type { BuiltSourceMap } from './map.js';

/** Frames of the event point here; the host does not exist, so the file is only a name for the map to match. */
const FRAME_HOST = 'https://e2e.invalid';
/** Line of the original source the map sends the frame to. */
const MAPPED_LINE = 6;

/** Everything the stages of `sourcemaps` need. */
export interface SourcemapsContext extends ScenarioContext {
  /** Map, minified file and source of the run. */
  built: BuiltSourceMap;
  /** Release of this run, which no other run shares. */
  release: string;
}

/**
 * Prints a value for an error text.
 * @param value Anything.
 * @returns The string itself or its JSON.
 */
function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'missing';
}

/**
 * Compares the card of the event with what the map must have made of it.
 * @param card Event card from the API.
 * @param built Map and source of the run.
 * @param release Release the event was sent with.
 * @param plan Plan of the run.
 * @param expectedCount How many times the event must have been counted.
 * @returns The first difference: the usual fields first, then the release, then the file and the lines of the first frame.
 */
export function checkSourcemapCard(card: EventCard, built: BuiltSourceMap, release: string, plan: RunPlan, expectedCount: number): CheckError | undefined {
  const basic = checkEventFields(card, plan, expectedCount);

  if (basic) {
    return basic;
  }

  if (card.release !== release) {
    return new CheckError('event_mismatch', { field: 'release',
      expected: release,
      actual: show(card.release) });
  }

  const [frame] = Array.isArray(card.backtrace) ? card.backtrace as Array<Record<string, unknown>> : [];

  if (frame?.file !== SOURCE_NAME) {
    return new CheckError('sourcemap_not_applied', { field: 'backtrace[0].file',
      expected: SOURCE_NAME,
      actual: show(frame?.file) });
  }

  const expected = expectedSourceCode(built.sourceLines, MAPPED_LINE);

  if (JSON.stringify(frame.sourceCode) !== JSON.stringify(expected)) {
    return new CheckError('sourcemap_not_applied', { field: 'backtrace[0].sourceCode',
      expected: `lines 1-${String(expected.length)} of ${SOURCE_NAME}`,
      actual: show(frame.sourceCode) });
  }

  return undefined;
}

/**
 * Builds the shape of the event of the run: a JavaScript event of the release of the run, with one frame of the minified file and no source lines.
 * @param context Context with the plan, the release and the map.
 * @returns Shape for the shared stages.
 */
export function sourcemapsShape(context: SourcemapsContext): EventShape {
  const { plan, config, release, built } = context;

  return { ...sendEventShape(context),
    message: (): CollectorMessage => ({ token: config.hawk.integrationToken,
      catcherType: plan.catcherType,
      payload: { title: plan.title,
        type: 'E2eMonitorCheck',
        release,
        backtrace: [{ file: `${FRAME_HOST}/${built.fileName}`,
          line: 1,
          column: 0 }],
        context: plan.context } }),
    check: (card, expectedCount) => checkSourcemapCard(card, built, release, plan, expectedCount) };
}

/**
 * Stage `release_uploaded`: sends the release with its map to the collector.
 * An answer that is lost leaves the stage uncertain: the next stage finds out whether the release was published.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function releaseUploadedStage(timeoutMs: number): StageSpec<SourcemapsContext> {
  return {
    name: 'release_uploaded',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { built, collector, config, release } = context;
      const outcome = await collector.uploadRelease(config.hawk.integrationToken, release, { name: `${built.fileName}.map`,
        content: JSON.stringify(built.map) }, signal);

      switch (outcome.kind) {
        case 'accepted':
          return { status: 'ok',
            details: { attempts: outcome.attempts } };
        case 'uncertain':
          return { status: 'uncertain',
            error: outcome.cause,
            details: { attempts: outcome.attempts } };
        case 'rejected':
          return { status: 'failed',
            error: outcome.error,
            details: { attempts: outcome.attempts } };
      }
    },
  };
}

/**
 * Stage `release_saved`: asks Hawk for the release until the file of the map is in it.
 * The collector says 200 when it has published the release, and the worker saves it later; Hawk answers «not found» until then.
 * @param timeoutMs Time the release may take to be saved.
 * @returns Stage spec.
 */
export function releaseSavedStage(timeoutMs: number): StageSpec<SourcemapsContext> {
  return {
    name: 'release_saved',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, built, clock, config, release } = context;
      let known = false;
      const poll = await pollUntil<true>(async (probeSignal) => {
        const details = await api.releaseDetails(config.hawk.projectId, release, probeSignal);

        known = known || details !== null;

        return details?.files.some(file => file.originFileName === built.fileName) === true
          ? { kind: 'found',
              value: true }
          : { kind: 'absent' };
      }, { clock,
        signal,
        scheduleMs: context.pollScheduleMs });

      if (poll.outcome === 'found') {
        return { status: 'ok',
          details: { attempts: poll.attempts,
            errors: poll.errors } };
      }

      if (poll.outcome === 'api_error') {
        return { status: 'failed',
          error: poll.lastError,
          details: { pollOutcome: 'api_error',
            errors: poll.errors } };
      }

      const waitedMs = Math.round(clock.monotonicMs() - poll.startedAtMs);

      return { status: 'failed',
        error: new CheckError('release_not_saved', { waitedMs,
          detail: known ? `the release is known but has no file of ${built.fileName}` : 'Hawk does not know the release' }),
        details: { pollOutcome: 'not_found',
          waitedMs,
          successes: poll.successes,
          errors: poll.errors } };
    },
  };
}
