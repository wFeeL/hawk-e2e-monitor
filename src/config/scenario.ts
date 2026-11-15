import type { ScenarioName } from '../scenarios/names.js';
import type { Config } from './load.js';

/** Settings that may differ from one scenario to another. */
export interface ScenarioSettings {
  /** Time between the starts of two runs. */
  intervalMs: number;
  /** Time after which a run counts as hung: its run, cleanup and the grace. */
  watchdogMs: number;
  /** Time a hung run keeps the scenario busy for its cleanup. */
  cleanupMs: number;
  /** Failed runs in a row that raise an alert. */
  alertAfterFailures: number;
  /** Days to keep finished runs. */
  retentionDays: number;
}

/**
 * Finds the settings of a scenario.
 * @param config Validated configuration.
 * @param _scenario Scenario; every scenario shares the global values until one gets its own.
 * @returns Interval, watchdog, cleanup time, alert threshold and retention.
 */
export function scenarioSettings(config: Config, _scenario: ScenarioName): ScenarioSettings {
  const { timeouts, monitoring } = config;

  return {
    intervalMs: monitoring.intervalMs,
    watchdogMs: timeouts.run + timeouts.cleanup + monitoring.watchdogGraceMs,
    cleanupMs: timeouts.cleanup,
    alertAfterFailures: monitoring.alertAfterFailures,
    retentionDays: monitoring.retentionDays,
  };
}
