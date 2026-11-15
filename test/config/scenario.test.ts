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
});
