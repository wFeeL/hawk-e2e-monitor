import type { Alerter } from '../alerting/alerter.js';
import type { Config } from '../config/load.js';
import { scenarioSettings } from '../config/scenario.js';
import type { Redactor } from '../errors/redact.js';
import { createHeartbeat, heartbeatReason } from '../heartbeat/heartbeat.js';
import type { Heartbeat } from '../heartbeat/heartbeat.js';
import type { Logger } from '../log/logger.js';
import type { MonitorMetrics } from '../metrics/metrics.js';
import type { Scheduler } from '../scheduler/scheduler.js';
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

  return createHeartbeat({ url: heartbeat.url,
    clock,
    logger: setup.logger,
    redact: setup.redact,
    httpTimeoutMs: config.httpTimeoutMs,
    intervalMs: heartbeat.intervalMs,
    reasonToSkip: () => heartbeatReason({ scheduler: scheduler.health(),
      alerts: alerter.health(),
      scenarios: config.monitoring.scenarios,
      lastVerdictAt: scenario => scheduler.lastVerdictAt(scenario),
      freshnessMs: (scenario) => {
        const settings = scenarioSettings(config, scenario);

        return settings.intervalMs + settings.watchdogMs;
      },
      nowWallMs: clock.wallTime().getTime(),
      startedWallMs }),
    onFailure: () => {
      setup.metrics.heartbeatFailed();
    } });
}
