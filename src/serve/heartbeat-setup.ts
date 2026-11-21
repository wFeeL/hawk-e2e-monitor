import type { Alerter } from '../alerting/alerter.js';
import type { Config } from '../config/load.js';
import { scenarioSettings } from '../config/scenario.js';
import type { Redactor } from '../errors/redact.js';
import { createHeartbeat, heartbeatReason } from '../heartbeat/heartbeat.js';
import type { Heartbeat } from '../heartbeat/heartbeat.js';
import type { Logger } from '../log/logger.js';
import type { MonitorMetrics } from '../metrics/metrics.js';
import { SCENARIO_NAMES, SCENARIO_TRAITS } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { heartbeatFirstSeenKey } from '../storage/keys.js';
import type { KvStore } from '../storage/kv.js';
import type { Clock } from '../time/clock.js';

/** What the heartbeat of `serve` is built from. */
export interface HeartbeatSetup {
  /** Validated configuration. */
  config: Config;
  /** Time source and sleeper. */
  clock: Clock;
  /** Logger that masks secrets. */
  logger: Logger;
  /** Masks the address of the ping. */
  redact: Redactor;
  /** Scheduler whose health and verdicts decide whether to ping. */
  scheduler: Scheduler;
  /** Alerter whose health decides whether to ping. */
  alerter: Alerter;
  /** Metrics that count failed pings. */
  metrics: MonitorMetrics;
  /** Store that keeps the first sighting of a scenario across restarts; without it the start of the process counts. */
  kv?: KvStore;
}

/**
 * Builds the heartbeat of `serve` when `HEARTBEAT_URL` is set.
 * @param setup Configuration and the parts whose health the heartbeat reports.
 * @returns The heartbeat, not started; undefined when there is no address to ping.
 */
export function createServeHeartbeat(setup: HeartbeatSetup): Heartbeat | undefined {
  const { config, clock, scheduler, alerter } = setup;
  const { heartbeat } = config.monitoring;

  if (heartbeat.url === undefined) {
    return undefined;
  }

  const startedWallMs = clock.wallTime().getTime();
  const firstSeen = new Map<ScenarioName, number>();

  // A crash loop restarts the process before any verdict, so the age of a silent scenario must outlive it.
  if (setup.kv !== undefined) {
    const { kv } = setup;
    const startedIso = clock.wallTime().toISOString();

    for (const scenario of config.monitoring.scenarios.filter(name => SCENARIO_TRAITS[name].inHeartbeat)) {
      try {
        const stored = kv.updateKv(heartbeatFirstSeenKey(scenario), current => current === undefined ? startedIso : undefined);
        const seen = Date.parse(stored ?? startedIso);

        firstSeen.set(scenario, Number.isNaN(seen) ? startedWallMs : seen);
      } catch (error) {
        setup.logger.warn('could not read or store the first sighting of a scenario; counting from the start of the process', { scenario,
          error });
      }
    }
  }

  // A scenario taken out of the configuration leaves its key behind; it would be stale if the scenario returned.
  if (setup.kv !== undefined) {
    for (const scenario of SCENARIO_NAMES.filter(name => !config.monitoring.scenarios.includes(name))) {
      try {
        setup.kv.deleteKv(heartbeatFirstSeenKey(scenario));
      } catch (error) {
        setup.logger.warn('could not delete the first sighting of a scenario', { scenario,
          error });
      }
    }
  }

  const forgetWithVerdict = (): void => {
    for (const scenario of [...firstSeen.keys()]) {
      if (scheduler.lastVerdictAt(scenario) === undefined) {
        continue;
      }

      firstSeen.delete(scenario);

      try {
        setup.kv?.deleteKv(heartbeatFirstSeenKey(scenario));
      } catch (error) {
        setup.logger.warn('could not delete the first sighting of a scenario', { scenario,
          error });
      }
    }
  };

  return createHeartbeat({ url: heartbeat.url,
    clock,
    logger: setup.logger,
    redact: setup.redact,
    httpTimeoutMs: config.httpTimeoutMs,
    intervalMs: heartbeat.intervalMs,
    reasonToSkip: () => {
      forgetWithVerdict();

      return heartbeatReason({ scheduler: scheduler.health(),
        alerts: alerter.health(),
        scenarios: config.monitoring.scenarios,
        lastVerdictAt: scenario => scheduler.lastVerdictAt(scenario),
        freshnessMs: (scenario) => {
          const settings = scenarioSettings(config, scenario);

          return settings.intervalMs + settings.watchdogMs;
        },
        nowWallMs: clock.wallTime().getTime(),
        startedWallMs,
        firstSeenAt: scenario => firstSeen.get(scenario) });
    },
    onFailure: () => {
      setup.metrics.heartbeatFailed();
    } });
}
