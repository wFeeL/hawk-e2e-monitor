import { describe, expect, it } from 'vitest';
import { receiverAvailabilityTimeoutMs, scenarioSettings } from '../../src/config/scenario.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
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

  it('gives the new scenarios their own interval and a watchdog from their stages', () => {
    // The test config has 300 ms availability, accept and visible limits, 600 ms cleanup and 30000 ms grace.
    const config = testConfig();

    expect(scenarioSettings(config, 'sentry-envelope')).toEqual({
      intervalMs: 3_600_000,
      watchdogMs: 300 + 300 + 300 + 300 + 600 + 30_000,
      cleanupMs: 600,
      alertAfterFailures: config.monitoring.alertAfterFailures,
      retentionDays: config.monitoring.retentionDays,
    });
    expect(scenarioSettings(config, 'sourcemaps')).toMatchObject({
      intervalMs: 3_600_000,
      watchdogMs: 300 + 300 + 300 + 60_000 + 300 + 300 + 600 + 30_000,
    });
    expect(scenarioSettings(config, 'new-project')).toMatchObject({
      intervalMs: 86_400_000,
      watchdogMs: 300 + 300 + 180_000 + 300 + 600 + 30_000,
      alertAfterFailures: 1,
    });
  });

  it('alerts new-project after one failure whatever the global threshold is', () => {
    const base = testConfig();
    const config = { ...base,
      monitoring: { ...base.monitoring,
        alertAfterFailures: 5 } };

    expect(scenarioSettings(config, 'new-project').alertAfterFailures).toBe(1);
    expect(scenarioSettings(config, 'sourcemaps').alertAfterFailures).toBe(5);
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

  it('adds the receiver check to the watchdog of the probe when a notification scenario is enabled', () => {
    const base = testConfig();

    for (const notification of ['check-notification', 'telegram-delivery'] as const) {
      const config = { ...base,
        monitoring: { ...base.monitoring,
          scenarios: ['endpoints-probe', notification] satisfies ScenarioName[] } };

      // 10 600 ms as without a notification scenario, plus 2 * 100 ms of HTTP and 1000 ms.
      expect(scenarioSettings(config, 'endpoints-probe').watchdogMs).toBe(10_600 + 1200);
    }
  });

  it('gives the receiver check two HTTP timeouts and a second', () => {
    expect(receiverAvailabilityTimeoutMs(100)).toBe(1200);
    expect(receiverAvailabilityTimeoutMs(10_000)).toBe(21_000);
  });
});
