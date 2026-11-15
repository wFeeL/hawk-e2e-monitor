import { describe, expect, it } from 'vitest';
import { EVENT_SCENARIOS, SCENARIO_NAMES, SCENARIO_TRAITS } from '../../src/scenarios/names.js';

describe('SCENARIO_TRAITS', () => {
  it('has a row for every scenario name', () => {
    expect(Object.keys(SCENARIO_TRAITS).toSorted()).toEqual([...SCENARIO_NAMES].toSorted());
  });

  it('derives the event scenarios from the table', () => {
    expect(EVENT_SCENARIOS).toEqual(SCENARIO_NAMES.filter(name => SCENARIO_TRAITS[name].sendsEvents));
    expect(EVENT_SCENARIOS).toEqual(['send-and-receive-event', 'check-notification']);
  });
});
