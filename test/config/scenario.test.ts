import { describe, expect, it } from 'vitest';
import { scenarioSettings } from '../../src/config/scenario.js';
import { testConfig } from '../support/config.js';

describe('scenarioSettings', () => {
  it('gives today\'s scenarios the global values', () => {
    const config = testConfig();
    const { monitoring, timeouts } = config;

    for (const scenario of ['send-and-receive-event', 'check-notification'] as const) {
      expect(scenarioSettings(config, scenario)).toEqual({
        intervalMs: monitoring.intervalMs,
        watchdogMs: timeouts.run + timeouts.cleanup + monitoring.watchdogGraceMs,
        cleanupMs: timeouts.cleanup,
        alertAfterFailures: monitoring.alertAfterFailures,
        retentionDays: monitoring.retentionDays,
      });
    }
  });

  it('gives the probe its own interval, threshold, retention and a watchdog from its stages', () => {
    const base = testConfig();
    const config = { ...base,
      monitoring: { ...base.monitoring,
        probe: { intervalMs: 90_000,
          alertAfterFailures: 3,
          retentionDays: 7 } } };

    expect(scenarioSettings(config, 'endpoints-probe')).toEqual({
      intervalMs: 90_000,
      // 300 ms collector and 300 ms API availability, plus the 10 s margin; no Garage address.
      watchdogMs: 10_600,
      cleanupMs: 0,
      alertAfterFailures: 3,
      retentionDays: 7,
    });
  });

  it('adds the Garage timeout to the watchdog of the probe when there is a Garage address', () => {
    const base = testConfig();
    const config = { ...base,
      hawk: { ...base.hawk,
        garageUrl: 'http://garage.example.test' },
      timeouts: { ...base.timeouts,
        garage: 400 } };

    expect(scenarioSettings(config, 'endpoints-probe').watchdogMs).toBe(11_000);
  });
});
