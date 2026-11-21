import { ALERT_BACKLOG_LIMIT_MS } from '../alerting/alerter.js';
import type { AlerterHealth } from '../alerting/alerter.js';
import type { Redactor } from '../errors/redact.js';
import type { Logger } from '../log/logger.js';
import { HttpStatus } from '../net/http-status.js';
import { NetworkError, SMALL_BODY_BYTES, httpRequest, networkFailureToCheckError } from '../net/http.js';
import { SCENARIO_TRAITS } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { SchedulerHealth } from '../scheduler/scheduler.js';
import type { Clock } from '../time/clock.js';
import { every } from '../time/every.js';
import { MS_PER_SECOND } from '../time/units.js';

const REJECTED_LIMIT = 3;
const LAST_OK_STATUS = 299;

/** Why the monitor does not ping. */
export interface SkipReason {
  /** Text that stays the same while the cause stays the same; a change of it is logged. */
  reason: string;
  /** Seconds a scenario has been silent; goes to the log next to the reason, not into it. */
  silentSeconds?: number;
}

/** What `createHeartbeat` needs. */
export interface HeartbeatDeps {
  /** Address to ping. */
  url: string;
  /** Time source and sleeper. */
  clock: Clock;
  /** Log; the address never reaches it unmasked. */
  logger: Logger;
  /** Masks the address and its path in everything that is logged. */
  redact: Redactor;
  /** Time limit of one ping. */
  httpTimeoutMs: number;
  /** Time between pings. */
  intervalMs: number;
  /** Tells why the monitor should not ping now; undefined when it is healthy. */
  reasonToSkip: () => SkipReason | undefined;
  /** Called when a ping did not reach the service. */
  onFailure?: () => void;
}

/** What one beat did. */
export type BeatOutcome = 'failed' | 'sent' | 'skipped';

/** Pings an outside service while the monitor is healthy. */
export interface Heartbeat {
  /** Starts the timer; the first ping is one interval away. */
  start(): void;
  /** Stops the timer and cancels a ping in flight. */
  stop(): void;
  /**
   * Makes one beat: pings unless the monitor has a reason not to.
   * @param signal Cancels the ping.
   * @returns `skipped` with a reason, `failed` when the ping did not succeed, `sent` otherwise; never rejects.
   */
  beatOnce(signal: AbortSignal): Promise<BeatOutcome>;
}

/** What `heartbeatReason` judges. */
export interface HeartbeatInput {
  /** Health of the scheduler. */
  scheduler: SchedulerHealth;
  /** Health of the alerts. */
  alerts: AlerterHealth;
  /** Enabled scenarios. */
  scenarios: readonly ScenarioName[];
  /** When a scenario last ended a run with a verdict, in wall-clock milliseconds. */
  lastVerdictAt: (scenario: ScenarioName) => number | undefined;
  /** How old the last verdict of a scenario may be. */
  freshnessMs: (scenario: ScenarioName) => number;
  /** Wall-clock milliseconds now. */
  nowWallMs: number;
  /** Wall-clock milliseconds of the start of the process, the age of a scenario that has no verdict yet. */
  startedWallMs: number;
  /** Wall-clock milliseconds a scenario without a verdict was first seen, kept across restarts; the start of the process when absent. */
  firstSeenAt?: (scenario: ScenarioName) => number | undefined;
}

/**
 * Tells why the monitor should not ping the heartbeat service, if it should not.
 * @param input Health of the scheduler and the alerts, and the age of the verdicts.
 * @returns The reason, or undefined when the monitor is healthy.
 */
export function heartbeatReason(input: HeartbeatInput): SkipReason | undefined {
  const { scheduler, alerts } = input;

  if (!scheduler.scheduler) {
    return { reason: 'scheduler unhealthy' };
  }

  if (!scheduler.storage || alerts.storageFailing) {
    return { reason: 'history writes fail' };
  }

  const [stuck] = scheduler.stuck;

  if (stuck !== undefined) {
    return { reason: `${stuck} is stuck` };
  }

  for (const scenario of input.scenarios.filter(name => SCENARIO_TRAITS[name].inHeartbeat)) {
    const ageMs = input.nowWallMs - (input.lastVerdictAt(scenario) ?? input.firstSeenAt?.(scenario) ?? input.startedWallMs);

    if (ageMs > input.freshnessMs(scenario)) {
      return { reason: `${scenario} has no verdict`,
        silentSeconds: Math.round(ageMs / MS_PER_SECOND) };
    }
  }

  if ((alerts.backlogAgeMs ?? 0) > ALERT_BACKLOG_LIMIT_MS || alerts.rejectedInRow >= REJECTED_LIMIT) {
    return { reason: 'alerts are not delivered' };
  }

  return undefined;
}

/**
 * Creates the heartbeat.
 * @param deps Address, clock, log and the check of the monitor's health.
 * @returns Heartbeat that is not started yet.
 */
export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { url, clock, logger, redact } = deps;
  const stopper = new AbortController();
  let skipped: string | undefined;
  let inFlight = false;

  const failed = (signal: AbortSignal, reason: string): BeatOutcome => {
    // A ping cancelled by a stop says nothing about the service.
    if (!signal.aborted) {
      logger.warn('heartbeat ping failed', { reason: redact(reason) });
      deps.onFailure?.();
    }

    return 'failed';
  };

  const ping = async (signal: AbortSignal): Promise<BeatOutcome> => {
    try {
      const response = await httpRequest({ url,
        method: 'GET',
        timeoutMs: deps.httpTimeoutMs,
        maxBytes: SMALL_BODY_BYTES,
        signal }, 'heartbeat');

      if (response.status >= HttpStatus.ok && response.status <= LAST_OK_STATUS) {
        return 'sent';
      }

      return failed(signal, `the service answered HTTP ${String(response.status)}`);
    } catch (error) {
      if (error instanceof NetworkError) {
        return failed(signal, networkFailureToCheckError(error, { url }).message);
      }

      return failed(signal, error instanceof Error ? error.message : String(error));
    }
  };

  const beatOnce: Heartbeat['beatOnce'] = async (signal) => {
    const skip = deps.reasonToSkip();

    if (skip !== undefined) {
      if (skip.reason !== skipped) {
        logger.warn(`heartbeat is not sent: ${skip.reason}`, skip.silentSeconds === undefined ? undefined : { silentSeconds: skip.silentSeconds });
      }

      skipped = skip.reason;

      return 'skipped';
    }

    skipped = undefined;

    return ping(signal);
  };

  const tick = (): void => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    beatOnce(stopper.signal)
      .catch((error: unknown) => {
        logger.error('heartbeat failed', { error });
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const start: Heartbeat['start'] = () => {
    every(clock, deps.intervalMs, stopper.signal, tick, (error) => {
      logger.error('heartbeat timer failed', { error });
    }).catch((error: unknown) => {
      logger.error('heartbeat timer failed', { error });
    });
  };

  const stop: Heartbeat['stop'] = () => {
    stopper.abort();
  };

  return {
    start,
    stop,
    beatOnce,
  };
}
