import { CHECK_NOTIFICATION, ENDPOINTS_PROBE, NEW_PROJECT, SEND_AND_RECEIVE_EVENT, SENTRY_ENVELOPE, SOURCEMAPS } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { Config } from './load.js';

/** A scenario that runs stages with a test event; the probe has settings of its own. */
export type ScenarioWithEvent = Exclude<ScenarioName, typeof ENDPOINTS_PROBE>;

const NEW_PROJECT_ALERT_AFTER_FAILURES = 1;

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

/** The time limits that make up the watchdog of a scenario. */
export interface WatchdogParts {
  /** Stage `collector_availability`. */
  collectorAvailability: number;
  /** Stage `api_availability`, also the limit of creating a project. */
  apiAvailability: number;
  /** Stage `collector_accept`, also the limit of uploading a release. */
  collectorAccept: number;
  /** Stage `event_visible`. */
  eventVisible: number;
  /** Stage `cleanup`. */
  cleanup: number;
  /** Whole run of the two original scenarios. */
  run: number;
  /** Time added before a run counts as hung. */
  graceMs: number;
  /** Stage `token_accepted`. */
  newProjectToken: number;
  /** Stage `release_saved`. */
  releaseSave: number;
}

/**
 * Adds up the limits of the stages a scenario runs, its cleanup and the grace.
 * @param scenario Scenario to measure.
 * @param parts Limits as numbers, from the configuration or from raw variables.
 * @returns Time after which a run of the scenario counts as hung.
 */
export function watchdogOf(scenario: ScenarioWithEvent, parts: WatchdogParts): number {
  const tail = parts.cleanup + parts.graceMs;

  switch (scenario) {
    case SEND_AND_RECEIVE_EVENT:
    case CHECK_NOTIFICATION:
      return parts.run + tail;
    case NEW_PROJECT:
      return parts.apiAvailability * 2 + parts.newProjectToken + parts.eventVisible + tail;
    case SOURCEMAPS:
      return parts.collectorAvailability + parts.apiAvailability + parts.collectorAccept * 2 + parts.releaseSave + parts.eventVisible + tail;
    case SENTRY_ENVELOPE:
      return parts.collectorAvailability + parts.apiAvailability + parts.collectorAccept + parts.eventVisible + tail;
  }
}

/**
 * Finds the time between the runs of a scenario.
 * @param config Validated configuration.
 * @param scenario Scenario to ask about.
 * @returns Its own interval, or the global one for the two original scenarios.
 */
function intervalOf(config: Config, scenario: ScenarioWithEvent): number {
  const { scenarios, monitoring } = config;

  switch (scenario) {
    case NEW_PROJECT:
      return scenarios.newProject.intervalMs;
    case SOURCEMAPS:
      return scenarios.sourcemaps.intervalMs;
    case SENTRY_ENVELOPE:
      return scenarios.sentryEnvelope.intervalMs;
    case SEND_AND_RECEIVE_EVENT:
    case CHECK_NOTIFICATION:
      return monitoring.intervalMs;
  }
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

  const { timeouts, monitoring, scenarios } = config;

  return {
    intervalMs: intervalOf(config, scenario),
    watchdogMs: watchdogOf(scenario, { ...timeouts,
      graceMs: monitoring.watchdogGraceMs,
      newProjectToken: scenarios.newProject.tokenTimeoutMs,
      releaseSave: scenarios.sourcemaps.releaseSaveTimeoutMs }),
    cleanupMs: timeouts.cleanup,
    alertAfterFailures: scenario === NEW_PROJECT ? NEW_PROJECT_ALERT_AFTER_FAILURES : monitoring.alertAfterFailures,
    retentionDays: monitoring.retentionDays,
  };
}
