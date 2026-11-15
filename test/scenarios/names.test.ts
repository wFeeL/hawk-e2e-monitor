import { describe, expect, it } from 'vitest';
import { EVENT_SCENARIOS, HIDDEN_SCENARIOS, SCENARIO_NAMES, SCENARIO_TRAITS } from '../../src/scenarios/names.js';

describe('SCENARIO_TRAITS', () => {
  it('has a row for every scenario name', () => {
    expect(Object.keys(SCENARIO_TRAITS).toSorted()).toEqual([...SCENARIO_NAMES].toSorted());
  });

  it('lists the probe last, and the probe is hidden by default and sends no events', () => {
    expect(SCENARIO_NAMES.at(-1)).toBe('endpoints-probe');
    expect(SCENARIO_TRAITS['endpoints-probe']).toEqual({ sendsEvents: false,
      inHeartbeat: false,
      hiddenByDefault: true });
  });

  it('derives the scenarios hidden by default from the table', () => {
    expect(HIDDEN_SCENARIOS).toEqual(['endpoints-probe']);
  });

  it('derives the event scenarios from the table', () => {
    expect(EVENT_SCENARIOS).toEqual(SCENARIO_NAMES.filter(name => SCENARIO_TRAITS[name].sendsEvents));
    expect(EVENT_SCENARIOS).toEqual(['send-and-receive-event', 'check-notification', 'new-project', 'sourcemaps', 'sentry-envelope', 'telegram-delivery']);
    expect(EVENT_SCENARIOS).not.toContain('endpoints-probe');
  });

  it('lists telegram-delivery before the probe with the traits of an event scenario', () => {
    expect(SCENARIO_NAMES.at(-2)).toBe('telegram-delivery');
    expect(SCENARIO_TRAITS['telegram-delivery']).toEqual({ sendsEvents: true,
      inHeartbeat: true,
      hiddenByDefault: false });
  });

  it('gives the new scenarios the same traits', () => {
    for (const name of ['new-project', 'sourcemaps', 'sentry-envelope'] as const) {
      expect(SCENARIO_TRAITS[name]).toEqual({ sendsEvents: true,
        inHeartbeat: true,
        hiddenByDefault: false });
    }
  });
});
