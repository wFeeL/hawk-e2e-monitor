import { describe, expect, it } from 'vitest';
import type { EventCard } from '../../../src/clients/hawk-api.js';
import { planRun } from '../../../src/scenarios/send-and-receive/plan.js';
import { checkSentryCard, sentryTitle } from '../../../src/scenarios/sentry-envelope/stages.js';
import { testConfig } from '../../support/config.js';

const plan = planRun(testConfig({ instanceId: 'mon' }), { sequence: 1,
  transport: 'http',
  catcherType: 'errors/default' }, 'sentry-envelope', count => 'a'.repeat(count));

/**
 * Builds the card of an event that came through the Sentry path, with changes.
 * @param changes Fields of the good card to replace.
 * @returns A good card but for the changes.
 */
function card(changes: Partial<EventCard> = {}): EventCard {
  return { originalEventId: 'e',
    groupHash: 'g',
    totalCount: 1,
    catcherType: 'errors/default',
    title: sentryTitle(plan),
    context: { e2e: { runId: plan.runId,
      instanceId: 'mon',
      scenario: 'sentry-envelope' } },
    ...changes };
}

describe('sentryTitle', () => {
  it('is the type of the exception, a colon and the value, which is the usual title of the run', () => {
    expect(sentryTitle(plan)).toBe(`E2eMonitorCheck: ${plan.title}`);
  });
});

describe('checkSentryCard', () => {
  it('accepts the event as the collector makes it', () => {
    expect(checkSentryCard(card(), plan, 'mon', 1)).toBeUndefined();
  });

  it.each([
    ['the title', { title: 'Other: x' }, 'title'],
    ['the catcher type', { catcherType: 'errors/javascript' }, 'catcherType'],
    ['the run id of the context', { context: { e2e: { runId: 'other',
      instanceId: 'mon',
      scenario: 'sentry-envelope' } } }, 'context.e2e.runId'],
    ['the instance of the context', { context: { e2e: { runId: plan.runId,
      instanceId: 'x',
      scenario: 'sentry-envelope' } } }, 'context.e2e.instanceId'],
    ['the scenario of the context', { context: { e2e: { runId: plan.runId,
      instanceId: 'mon',
      scenario: 'x' } } }, 'context.e2e.scenario'],
    ['a context that is not there', { context: null }, 'context.e2e'],
    ['a context without e2e', { context: { other: 1 } }, 'context.e2e'],
  ] as const)('names %s when it differs', (_name, changes, field) => {
    expect(checkSentryCard(card(changes as Partial<EventCard>), plan, 'mon', 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field } });
  });

  it('names context.e2e before the title when the event has no e2e context', () => {
    expect(checkSentryCard(card({ title: 'Other: x',
      context: {} }), plan, 'mon', 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'context.e2e' } });
  });

  it('counts the event', () => {
    expect(checkSentryCard(card({ totalCount: 2 }), plan, 'mon', 1)).toMatchObject({ errorClass: 'duplicate_event' });
    expect(checkSentryCard(card({ totalCount: 1 }), plan, 'mon', 2)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'totalCount' } });
  });
});
