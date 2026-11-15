import { describe, expect, it } from 'vitest';
import { EVENT_SCENARIOS, SCENARIO_NAMES, SCENARIO_TRAITS } from '../../src/scenarios/names.js';

describe('SCENARIO_TRAITS', () => {
  it('has a row for every scenario name', () => {
    expect(Object.keys(SCENARIO_TRAITS).toSorted()).toEqual([...SCENARIO_NAMES].toSorted());
  });

  it('derives the event scenarios from the table', () => {
    expect(EVENT_SCENARIOS).toEqual(SCENARIO_NAMES.filter(name => SCENARIO_TRAITS[name].sendsEvents));
    expect(EVENT_SCENARIOS).toEqual(['send-and-receive-event', 'check-notification', 'new-project', 'sourcemaps', 'sentry-envelope']);
  });

  it('gives the new scenarios the same traits', () => {
    for (const name of ['new-project', 'sourcemaps', 'sentry-envelope'] as const) {
      expect(SCENARIO_TRAITS[name]).toEqual({ sendsEvents: true,
        inHeartbeat: true,
        hiddenByDefault: false });
    }
  });
});
