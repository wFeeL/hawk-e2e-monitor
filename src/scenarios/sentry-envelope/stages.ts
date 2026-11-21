import type { CollectorMessage } from '../../clients/collector.js';
import type { EventCard, FoundEvent } from '../../clients/hawk-api.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import { SENTRY_ENVELOPE } from '../names.js';
import type { RunPlan } from '../shared/plan.js';
import type { EventShape } from '../shared/event.js';
import type { ScenarioContext } from '../shared/context.js';
import { EXCEPTION_TYPE, buildEnvelope } from './envelope.js';

/** Catcher type the collector gives an event of a Sentry SDK that is not a JavaScript one. */
export const DEFAULT_CATCHER = 'errors/default';

/**
 * Builds the title Hawk shows for the event of a run: the type, a colon and the value of the exception.
 * @param plan Plan of the run, whose title is the value.
 * @returns Title as the collector composes it.
 */
export function sentryTitle(plan: RunPlan): string {
  return `${EXCEPTION_TYPE}: ${plan.title}`;
}

/**
 * Reads the `e2e` context of an event, where the envelope put its contexts.
 * @param context Context as Hawk returns it.
 * @returns The object, an empty one when there is none.
 */
function e2eContext(context: unknown): Record<string, unknown> {
  const e2e = typeof context === 'object' && context !== null ? (context as Record<string, unknown>).e2e : undefined;

  return typeof e2e === 'object' && e2e !== null ? e2e as Record<string, unknown> : {};
}

/**
 * Tells whether the context has the `e2e` object the envelope put there.
 * @param context Context as Hawk returns it.
 * @returns True when there is one.
 */
function hasE2eContext(context: unknown): boolean {
  const e2e = typeof context === 'object' && context !== null ? (context as Record<string, unknown>).e2e : undefined;

  return typeof e2e === 'object' && e2e !== null;
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
 * Compares the card of the event with what the envelope said.
 * @param card Event card from the API.
 * @param plan Plan of the run.
 * @param instanceId Id of this monitor.
 * @param expectedCount How many times the event must have been counted.
 * @returns The first difference: title, catcher type, the `e2e` context, then the count.
 */
export function checkSentryCard(card: EventCard, plan: RunPlan, instanceId: string, expectedCount: number): CheckError | undefined {
  const e2e = e2eContext(card.context);

  if (!hasE2eContext(card.context)) {
    return new CheckError('event_mismatch', { field: 'context.e2e',
      expected: 'object',
      actual: 'missing' });
  }

  const fields: Array<[string, unknown, string]> = [
    ['title', card.title, sentryTitle(plan)],
    ['catcherType', card.catcherType, DEFAULT_CATCHER],
    ['context.e2e.runId', e2e.runId, plan.runId],
    ['context.e2e.instanceId', e2e.instanceId, instanceId],
    ['context.e2e.scenario', e2e.scenario, SENTRY_ENVELOPE],
  ];

  for (const [field, actual, expected] of fields) {
    if (actual !== expected) {
      return new CheckError('event_mismatch', { field,
        expected,
        actual: show(actual) });
    }
  }

  if (card.totalCount > expectedCount) {
    return new CheckError('duplicate_event', { count: card.totalCount });
  }

  if (card.totalCount < expectedCount) {
    return new CheckError('event_mismatch', { field: 'totalCount',
      expected: String(expectedCount),
      actual: String(card.totalCount) });
  }

  return undefined;
}

/**
 * Tells whether an event came from the envelope of this run and instance: the title carries the value of the exception and the context names the instance.
 * An event with exactly the title of the run is ours even when its context was lost, so the card check can name the lost context.
 * @param event Event from the API.
 * @param plan Plan of the run.
 * @param instanceId Id of this monitor.
 * @returns True for our event.
 */
function isOurSentryEvent(event: FoundEvent, plan: RunPlan, instanceId: string): boolean {
  return event.title === sentryTitle(plan)
    || (event.title.includes(`[e2e:${instanceId}] ${plan.runId}`) && e2eContext(event.context).instanceId === instanceId);
}

/**
 * Builds the shape of the event of the run for the shared stages: found by its title and its `e2e` context, checked as the collector makes the event.
 * @param context Scenario context with the plan and the configuration.
 * @returns Shape of the event.
 */
export function sentryShape(context: ScenarioContext): EventShape {
  const { plan, config } = context;

  return { projectId: config.hawk.projectId,
    // The envelope is not a collector message; this is the event Hawk is expected to show.
    message: (): CollectorMessage => ({ token: config.hawk.integrationToken,
      catcherType: DEFAULT_CATCHER,
      payload: { title: sentryTitle(plan),
        context: { e2e: { runId: plan.runId,
          instanceId: config.instanceId,
          scenario: SENTRY_ENVELOPE } } } }),
    matches: event => isOurSentryEvent(event, plan, config.instanceId),
    check: (card, expectedCount) => checkSentryCard(card, plan, config.instanceId, expectedCount),
    isOurs: event => isOurSentryEvent(event, plan, config.instanceId) };
}

/**
 * Stage `collector_accept`: posts the envelope to the Sentry path of the collector.
 * A 200 does not say that an event was made of it; the search finds that out.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function envelopeAcceptStage(timeoutMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'collector_accept',
    timeoutMs,
    run: async ({ clock, collector, config, plan, state }, signal): Promise<StageOutcome> => {
      const token = decodeIntegrationToken(config.hawk.integrationToken);

      if (token === undefined) {
        throw new CheckError('monitor_internal', { detail: 'the integration token does not decode' });
      }

      const body = buildEnvelope({ instanceId: config.instanceId,
        runId: plan.runId,
        scenario: SENTRY_ENVELOPE,
        sentAt: clock.wallTime() });
      const startedMs = clock.monotonicMs();

      // A send that never returns leaves the flag up, so the cleanup still looks for the event.
      state.sendMayHaveReached = true;

      const outcome = await collector.sendEnvelope(tokenKey(token), body, signal);

      state.sendOutcome = outcome;

      switch (outcome.kind) {
        case 'accepted':
          state.sendMayHaveReached = false;
          state.acceptedAtMs = clock.monotonicMs();

          return { status: 'ok',
            details: { attempts: outcome.attempts } };
        case 'uncertain':
          state.sendMayHaveReached = true;
          state.acceptedAtMs = startedMs;

          return { status: 'uncertain',
            error: outcome.cause,
            details: { attempts: outcome.attempts,
              warning: `The collector did not confirm the envelope (${outcome.cause.message}); SDKs of users may see an error` } };
        case 'rejected':
          state.sendMayHaveReached = false;

          return { status: 'failed',
            error: outcome.error,
            details: { attempts: outcome.attempts } };
      }
    },
  };
}
