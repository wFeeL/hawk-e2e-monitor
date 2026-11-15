import { describe, expect, it } from 'vitest';
import { EVENT_SCENARIOS, SCENARIO_NAMES, SCENARIO_TRAITS } from '../../src/scenarios/names.js';

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

  it('derives the event scenarios from the table', () => {
    expect(EVENT_SCENARIOS).toEqual(SCENARIO_NAMES.filter(name => SCENARIO_TRAITS[name].sendsEvents));
    expect(EVENT_SCENARIOS).toEqual(['send-and-receive-event', 'check-notification']);
    expect(EVENT_SCENARIOS).not.toContain('endpoints-probe');
  });
});
