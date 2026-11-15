import { ENDPOINTS_PROBE } from '../scenarios/names.js';
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

/** Time added to the timeouts of the probe stages before a probe counts as hung. */
export const PROBE_WATCHDOG_MARGIN_MS = 10_000;

/**
 * Finds the settings of the probe: its own interval, threshold and retention, and a watchdog from the timeouts of its stages.
 * @param config Validated configuration.
 * @returns Settings of `endpoints-probe`; it has no cleanup.
 */
function probeSettings(config: Config): ScenarioSettings {
  const { timeouts, hawk, monitoring } = config;
  const budgetMs = timeouts.collectorAvailability + timeouts.apiAvailability + (hawk.garageUrl === undefined ? 0 : timeouts.garage);

  return {
    intervalMs: monitoring.probe.intervalMs,
    watchdogMs: budgetMs + PROBE_WATCHDOG_MARGIN_MS,
    cleanupMs: 0,
    alertAfterFailures: monitoring.probe.alertAfterFailures,
    retentionDays: monitoring.probe.retentionDays,
  };
}

/**
 * Finds the settings of a scenario.
 * @param config Validated configuration.
 * @param scenario Scenario; the probe has its own values, every other scenario shares the global ones.
 * @returns Interval, watchdog, cleanup time, alert threshold and retention.
 */
export function scenarioSettings(config: Config, scenario: ScenarioName): ScenarioSettings {
  if (scenario === ENDPOINTS_PROBE) {
    return probeSettings(config);
  }

  const { timeouts, monitoring } = config;

  return {
    intervalMs: monitoring.intervalMs,
    watchdogMs: timeouts.run + timeouts.cleanup + monitoring.watchdogGraceMs,
    cleanupMs: timeouts.cleanup,
    alertAfterFailures: monitoring.alertAfterFailures,
    retentionDays: monitoring.retentionDays,
  };
}
