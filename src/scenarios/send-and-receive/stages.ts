import type { CollectorClient, CollectorMessage, SendOutcome } from '../../clients/collector.js';
import type { FoundEvent, HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import { pollUntil } from '../../engine/poll.js';
import type { PollResult } from '../../engine/poll.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Clock } from '../../time/clock.js';
import type { RunPlan } from './plan.js';

const LOW_QUOTA_SHARE = 0.1;

/** What the stages learn on the way and hand to later stages and the verdict. */
export interface ScenarioState {
  /** Outcome of the first send. */
  sendOutcome?: SendOutcome;
  /** True when the event may have reached the collector although no answer confirmed it. */
  sendMayHaveReached: boolean;
  /** Monotonic time of the collector's answer, or of the start of the send when it is uncertain. */
  acceptedAtMs?: number;
  /** Outcome of the second send. */
  repeatOutcome?: SendOutcome;
  /** The event found in Hawk. */
  event?: FoundEvent;
  /** Time from `acceptedAtMs` to the first sighting. */
  latencyMs?: number;
  /** How the poll of stage 4 ended. */
  pollSummary?: PollResult<FoundEvent>;
}

/** Everything a stage needs. */
export interface ScenarioContext {
  /** Validated configuration. */
  config: Config;
  /** Decisions made before the run. */
  plan: RunPlan;
  /** Collector client. */
  collector: CollectorClient;
  /** Hawk API client. */
  api: HawkApi;
  /** Time source. */
  clock: Clock;
  /** Shared state of the run. */
  state: ScenarioState;
  /** Poll schedule override, for tests. */
  pollScheduleMs?: readonly number[];
}

/**
 * Builds the message of the test event.
 * @param context Scenario context.
 * @returns Message for the collector client.
 */
export function eventMessage(context: ScenarioContext): CollectorMessage {
  const { plan, config } = context;

  return { token: config.hawk.integrationToken,
    catcherType: plan.catcherType,
    payload: { title: plan.title,
      type: 'e2e-check',
      context: plan.context } };
}

/**
 * Stage 1: the collector answers `/health` and rejects an unknown token over WebSocket.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAvailabilityStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'collector_availability',
    budgetMs,
    run: async ({ collector }, signal) => {
      await collector.health(signal);
      await collector.probeInvalidToken(signal);

      return { status: 'ok' };
    },
  };
}

/**
 * Stage 2: the monitor can sign in, the token belongs to the project and the workspace has quota.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function apiAvailabilityStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'api_availability',
    budgetMs,
    run: async ({ api, config }, signal): Promise<StageOutcome> => {
      const { projectId, integrationToken } = config.hawk;

      await api.ensureSession(signal);

      const hawkToken = decodeIntegrationToken(await api.projectToken(projectId, signal));
      const ownToken = decodeIntegrationToken(integrationToken);

      if (hawkToken === undefined || ownToken === undefined || tokenKey(hawkToken) !== tokenKey(ownToken)) {
        throw new CheckError('token_mismatch');
      }

      const quota = await api.workspaceQuota(projectId, signal);
      const usage = `${String(quota.eventsCount)}/${String(quota.eventsLimit)}`;

      if (quota.isBlocked) {
        throw new CheckError('workspace_blocked', { detail: usage });
      }

      if (quota.eventsCount >= quota.eventsLimit) {
        throw new CheckError('quota_exhausted', { detail: usage });
      }

      const left = (quota.eventsLimit - quota.eventsCount) / quota.eventsLimit;

      return left < LOW_QUOTA_SHARE
        ? { status: 'ok',
            details: { warning: `Event quota is almost used: ${usage}` } }
        : { status: 'ok' };
    },
  };
}

/**
 * Stage 3: sends the event over the planned transport.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAcceptStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'collector_accept',
    budgetMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { collector, clock, plan, state } = context;
      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(eventMessage(context), plan.transport, signal);

      state.sendOutcome = outcome;

      switch (outcome.kind) {
        case 'accepted':
          state.acceptedAtMs = clock.monotonicMs();

          return { status: 'ok',
            details: { attempts: outcome.attempts } };
        case 'uncertain':
          state.sendMayHaveReached = true;
          state.acceptedAtMs = startedMs;

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
 * Reads a key of an event context.
 * @param context Context as the API returns it.
 * @param key Key to read.
 * @returns The value, or undefined when the context is not an object.
 */
function contextValue(context: unknown, key: string): unknown {
  return typeof context === 'object' && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Prints a compared value for an error text.
 * @param value Anything.
 * @returns The string itself or its JSON.
 */
function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
}

/**
 * Compares the event Hawk shows with the one we sent.
 * @param event Event from the API.
 * @param plan Plan of the run.
 * @param expectedCount How many times the event must have been counted.
 * @returns The first difference as an error: fields in the order title, context, catcher type, count.
 */
export function checkEventFields(event: FoundEvent, plan: RunPlan, expectedCount: number): CheckError | undefined {
  const fields: Array<[string, unknown, string]> = [
    ['title', event.title, plan.title],
    ['context.runId', contextValue(event.context, 'runId'), plan.runId],
    ['context.instanceId', contextValue(event.context, 'instanceId'), plan.context.instanceId],
    ['catcherType', event.catcherType, plan.catcherType],
  ];

  for (const [field, actual, expected] of fields) {
    if (actual !== expected) {
      return new CheckError('event_mismatch', { field,
        expected,
        actual: show(actual) });
    }
  }

  if (event.totalCount > expectedCount) {
    return new CheckError('duplicate_event', { count: event.totalCount });
  }

  if (event.totalCount < expectedCount) {
    return new CheckError('event_mismatch', { field: 'totalCount',
      expected: String(expectedCount),
      actual: String(event.totalCount) });
  }

  return undefined;
}

/**
 * Tells whether an event is the one this run sent, so it may be removed.
 * Either the title carries our prefix, or the context names this run and this instance.
 * @param event Event from the API.
 * @param plan Plan of the run.
 * @param instanceId Id of this monitor.
 * @returns True for our event.
 */
export function isOurEvent(event: FoundEvent, plan: RunPlan, instanceId: string): boolean {
  return event.title.startsWith(`[e2e:${instanceId}] ${plan.runId} `)
    || (contextValue(event.context, 'runId') === plan.runId && contextValue(event.context, 'instanceId') === instanceId);
}

/**
 * Stage 4: waits until the event is visible in the API and checks its fields.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function eventVisibleStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'event_visible',
    budgetMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, config, plan, state } = context;
      const { projectId } = config.hawk;
      const poll = await pollUntil<FoundEvent>(async (probeSignal) => {
        const events = await api.findEvents(projectId, plan.runId, probeSignal);
        const hit = events.find(event => event.title === plan.title || contextValue(event.context, 'runId') === plan.runId);

        return hit
          ? { kind: 'found',
              value: hit }
          : { kind: 'absent' };
      }, { clock,
        signal,
        scheduleMs: context.pollScheduleMs });

      state.pollSummary = poll;

      if (poll.outcome === 'not_found') {
        const now = clock.monotonicMs();
        const waitedMs = Math.round(now - poll.startedAtMs);

        return { status: 'failed',
          error: new CheckError('event_not_found', { waitedMs,
            successes: poll.successes,
            errors: poll.errors,
            lastSuccessAgoMs: Math.round(now - poll.lastSuccessAtMs) }),
          details: { pollOutcome: 'not_found',
            waitedMs,
            successes: poll.successes,
            errors: poll.errors } };
      }

      if (poll.outcome === 'api_error') {
        return { status: 'failed',
          error: poll.lastError,
          details: { pollOutcome: 'api_error',
            waitedMs: Math.round(clock.monotonicMs() - poll.startedAtMs),
            errors: poll.errors } };
      }

      state.event = poll.value;

      if (state.acceptedAtMs !== undefined) {
        state.latencyMs = poll.foundAtMs - state.acceptedAtMs;
      }

      const card = await api.eventCard(projectId, poll.value.originalEventId, signal);

      if (card === null) {
        throw new CheckError('event_mismatch', { field: 'event',
          expected: 'present',
          actual: 'missing' });
      }

      state.event = card;

      const mismatch = checkEventFields(card, plan, 1);

      if (mismatch) {
        throw mismatch;
      }

      return { status: 'ok',
        details: { pollOutcome: 'found',
          attempts: poll.attempts,
          errors: poll.errors } };
    },
  };
}

/**
 * Stage 5: sends the event again and waits until Hawk counts it twice.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function eventRepeatedStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'event_repeated',
    budgetMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, collector, config, plan, state } = context;
      const { projectId } = config.hawk;

      if (!plan.repeat) {
        return { status: 'skipped' };
      }

      const first = state.event;

      if (first === undefined) {
        throw new CheckError('monitor_internal', { detail: 'event_repeated ran without a found event' });
      }

      const outcome = await collector.send(eventMessage(context), plan.transport, signal);

      state.repeatOutcome = outcome;

      if (outcome.kind === 'rejected') {
        return { status: 'failed',
          error: outcome.error,
          details: { attempts: outcome.attempts } };
      }

      let lastCount = 1;
      const poll = await pollUntil<FoundEvent>(async (probeSignal) => {
        const card = await api.eventCard(projectId, first.originalEventId, probeSignal);

        if (card === null) {
          return { kind: 'absent' };
        }

        lastCount = card.totalCount;

        return card.totalCount >= 2
          ? { kind: 'found',
              value: card }
          : { kind: 'absent' };
      }, { clock,
        signal,
        scheduleMs: context.pollScheduleMs });

      if (poll.outcome === 'found') {
        state.event = poll.value;

        const duplicate = checkEventFields(poll.value, plan, 2);

        return duplicate
          ? { status: 'failed',
              error: duplicate,
              details: { pollOutcome: 'found' } }
          : { status: 'ok',
              details: { pollOutcome: 'found',
                attempts: poll.attempts,
                repeatUncertain: outcome.kind === 'uncertain' } };
      }

      const waitedMs = Math.round(clock.monotonicMs() - poll.startedAtMs);
      const uncertain = outcome.kind === 'uncertain' ? outcome.cause : undefined;

      if (poll.outcome === 'api_error') {
        const suffix = '; the repeated event was not confirmed by the collector either';

        return { status: 'failed',
          error: uncertain
            ? new CheckError(poll.lastError.errorClass, poll.lastError.facts, { message: `${poll.lastError.message}${suffix}` })
            : poll.lastError,
          details: { pollOutcome: 'api_error',
            waitedMs,
            errors: poll.errors } };
      }

      return { status: 'failed',
        error: uncertain
          ? new CheckError(uncertain.errorClass, uncertain.facts, { message: `Collector did not confirm the repeated event (${uncertain.message}); it was not counted twice within ${String(waitedMs)} ms` })
          : new CheckError('repeat_not_counted', { count: lastCount,
            waitedMs }),
        details: { pollOutcome: 'not_found',
          waitedMs,
          successes: poll.successes,
          errors: poll.errors } };
    },
  };
}

/**
 * Wraps a failure of a cleanup call into `cleanup_failed`.
 * @param error What the call threw.
 * @returns Error of class `cleanup_failed`, or the input when it is not a check error.
 */
function cleanupFailure(error: unknown): unknown {
  return error instanceof CheckError
    ? new CheckError('cleanup_failed', { detail: error.message }, { cause: error })
    : error;
}

/**
 * Stage 6: removes the test event when it is ours.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function cleanupStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'cleanup',
    budgetMs,
    run: async ({ api, clock, config, plan, state }, signal): Promise<StageOutcome> => {
      const { projectId } = config.hawk;
      const refuse = (event: FoundEvent): CheckError => new CheckError('cleanup_refused', { detail: `"${event.title}" (${event.originalEventId})` });
      const details: Record<string, unknown> = {};
      let target = state.event;

      if (target === undefined) {
        // An accepted event may still be on its way through the workers, so look for it too.
        if (!state.sendMayHaveReached && state.sendOutcome?.kind !== 'accepted') {
          return { status: 'skipped' };
        }

        let found: FoundEvent[];

        try {
          found = await api.findEvents(projectId, plan.runId, signal);
        } catch (error) {
          throw cleanupFailure(error);
        }

        const [first] = found;

        if (first === undefined) {
          return { status: 'skipped',
            details: { found: false } };
        }

        target = found.find(event => isOurEvent(event, plan, config.instanceId));

        if (target === undefined) {
          throw refuse(first);
        }

        // The event outran stage 4's deadline; leave a trace so the late arrival is visible in the result.
        details.foundBySearch = true;
        details.originalEventId = target.originalEventId;
      } else {
        if (!isOurEvent(target, plan, config.instanceId)) {
          throw refuse(target);
        }

        // A worker may count one more copy after the check, so wait a little before the recheck.
        // The verdict reads the count from `details`.
        let cut = false;

        if (config.lateDuplicateWaitMs > 0) {
          try {
            await clock.sleep(config.lateDuplicateWaitMs, signal);
          } catch {
            cut = true;
          }
        }

        if (cut) {
          // The budget ran out during the pause; removal still gets its try.
          details.recheck = 'skipped';
          details.warning = 'The event count was not rechecked: the cleanup time limit cut the wait';
        } else {
          // The read gets one HTTP timeout of its own, so retries inside the transport cannot eat the time the removal needs.
          const recheck = new AbortController();
          const timer = new AbortController();
          const onStageAbort = (): void => {
            recheck.abort();
          };

          if (signal.aborted) {
            onStageAbort();
          } else {
            signal.addEventListener('abort', onStageAbort, { once: true });
          }

          clock.sleep(config.httpTimeoutMs, timer.signal).then(onStageAbort, () => undefined);

          try {
            const card = await api.eventCard(projectId, target.originalEventId, recheck.signal);

            if (card === null) {
              details.recheck = 'missing';
            } else if (card.totalCount > target.totalCount) {
              details.lateTotalCount = card.totalCount;
            }
          } catch (error) {
            if (!(error instanceof CheckError)) {
              throw error;
            }

            details.recheck = 'failed';
            details.warning = `The event count could not be rechecked before cleanup: ${error.message}`;
          } finally {
            timer.abort();
            signal.removeEventListener('abort', onStageAbort);
          }
        }
      }

      const withDetails = (outcome: StageOutcome): StageOutcome => Object.keys(details).length > 0
        ? { ...outcome,
            details }
        : outcome;
      let removed: boolean;

      try {
        removed = await api.removeEvent(projectId, target.originalEventId, signal);
      } catch (error) {
        const failure = cleanupFailure(error);

        if (!(failure instanceof CheckError)) {
          throw failure;
        }

        return withDetails({ status: 'failed',
          error: failure });
      }

      if (!removed) {
        return withDetails({ status: 'failed',
          error: new CheckError('cleanup_failed', { detail: 'Hawk answered that nothing was removed' }) });
      }

      if (details.foundBySearch === true) {
        details.warning = 'The event appeared only after the event_visible deadline and was removed by cleanup';
      }

      return withDetails({ status: 'ok' });
    },
  };
}
