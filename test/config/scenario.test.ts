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
});
