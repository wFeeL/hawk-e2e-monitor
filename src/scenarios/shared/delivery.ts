import { formatDuration } from '../../time/format.js';
import type { EventCard, FoundEvent } from '../../clients/hawk-api.js';
import { pollUntil } from '../../engine/poll.js';
import type { StageDetails } from '../../engine/result.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { ScenarioContext } from './context.js';
import { shapeOf, workerMissing } from './event.js';

/**
 * Stage 3: sends the event over the planned transport.
 * @param timeoutMs Time limit of the stage.
 * @param beforeSend Called right before the first send, for what must be in place before the event leaves.
 * @returns Stage spec.
 */
export function collectorAcceptStage(timeoutMs: number, beforeSend?: () => void): StageSpec<ScenarioContext> {
  return {
    name: 'collector_accept',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { collector, clock, plan, state } = context;

      beforeSend?.();

      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(shapeOf(context).message(context), plan.transport, signal);

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
            details: { attempts: outcome.attempts,
              warning: `The collector did not confirm the event (${outcome.cause.message}); SDKs of users may see an error` } };
        case 'rejected':
          return { status: 'failed',
            error: outcome.error,
            details: { attempts: outcome.attempts } };
      }
    },
  };
}

/**
 * Stage 4: waits until the event is visible in the API and checks its fields.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function eventVisibleStage(timeoutMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'event_visible',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, config, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;
      // The search leaves one HTTP timeout of the stage for the card read, which keeps the stage signal.
      const search = new AbortController();
      const timer = new AbortController();
      const onStageAbort = (): void => {
        search.abort();
      };

      if (signal.aborted) {
        onStageAbort();
      } else {
        signal.addEventListener('abort', onStageAbort, { once: true });
      }

      clock.sleep(Math.max(timeoutMs - config.httpTimeoutMs, 0), timer.signal).then(onStageAbort, () => undefined);

      let poll;

      try {
        poll = await pollUntil<FoundEvent>(async (probeSignal) => {
          const events = await api.findEvents(projectId, plan.runId, probeSignal);
          const hit = events.find(event => shape.matches(event));

          return hit
            ? { kind: 'found',
                value: hit }
            : { kind: 'absent' };
        }, { clock,
          signal: search.signal,
          scheduleMs: context.pollScheduleMs });
      } finally {
        timer.abort();
        signal.removeEventListener('abort', onStageAbort);
      }

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

      const mismatch = shape.check(card, 1);

      if (mismatch) {
        throw mismatch;
      }

      const details: StageDetails = { pollOutcome: 'found',
        attempts: poll.attempts,
        errors: poll.errors };

      if (workerMissing(card, shape.message(context).payload)) {
        details.degraded = ['js_worker_not_seen'];
        details.warning = 'The JavaScript event has no beautifiedUserAgent: the JavaScript worker did not handle it, or Hawk routes JavaScript events elsewhere';
      }

      return { status: 'ok',
        details };
    },
  };
}

/**
 * Stage 5: sends the event again and waits until Hawk counts it twice.
 * @param timeoutMs Time limit of the stage.
 * @param beforeSend Called right before the second send, for what must be known before the repeat leaves.
 * @returns Stage spec.
 */
export function eventRepeatedStage(timeoutMs: number, beforeSend?: () => void): StageSpec<ScenarioContext> {
  return {
    name: 'event_repeated',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, collector, plan, state } = context;
      const shape = shapeOf(context);
      const { projectId } = shape;

      if (!plan.repeat) {
        return { status: 'skipped' };
      }

      const first = state.event;

      if (first === undefined) {
        throw new CheckError('monitor_internal', { detail: 'event_repeated ran without a found event' });
      }

      beforeSend?.();

      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(shape.message(context), plan.transport, signal);

      state.repeatOutcome = outcome;
      state.repeatAcceptedAtMs = outcome.kind === 'accepted' ? clock.monotonicMs() : startedMs;

      if (outcome.kind === 'rejected') {
        return { status: 'failed',
          error: outcome.error,
          details: { attempts: outcome.attempts } };
      }

      let lastCount = 1;
      const poll = await pollUntil<EventCard>(async (probeSignal) => {
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

        const duplicate = shape.check(poll.value, 2);

        return duplicate
          ? { status: 'failed',
              error: duplicate,
              details: { pollOutcome: 'found' } }
          : { status: 'ok',
              details: { pollOutcome: 'found',
                attempts: poll.attempts,
                repeatUncertain: outcome.kind === 'uncertain',
                ...outcome.kind === 'uncertain'
                  ? { warning: `The collector did not confirm the repeated event (${outcome.cause.message}); SDKs of users may see an error` }
                  : {} } };
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
          ? new CheckError(uncertain.errorClass, uncertain.facts, { message: `Collector did not confirm the repeated event (${uncertain.message}); it was not counted twice within ${formatDuration(waitedMs)}` })
          : new CheckError('repeat_not_counted', { count: lastCount,
            waitedMs }),
        details: { pollOutcome: 'not_found',
          waitedMs,
          successes: poll.successes,
          errors: poll.errors } };
    },
  };
}
