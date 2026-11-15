import perfHooks from 'node:perf_hooks';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { TRANSPORTS } from '../clients/collector.js';
import { STAGE_NAMES, STAGE_STATUSES } from '../engine/result.js';
import type { RunResult } from '../engine/result.js';
import { CULPRITS, ERROR_CLASSES } from '../errors/taxonomy.js';
import type { Logger } from '../log/logger.js';
import { CHANNELS } from '../notifications/types.js';
import { SCENARIO_NAMES } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { History } from '../storage/history.js';
import { isMonitorAbort, isVerdict } from '../storage/outcome.js';
import { DEGRADED_CODES, RUN_TRIGGERS } from '../storage/types.js';
import type { RunRow } from '../storage/types.js';
import { MS_PER_SECOND } from '../time/units.js';

const PREFIX = 'hawk_e2e_';
const NO_STAGE = 'none';
const DEGRADED_STATUS = 0.5;
const RUN_STATUSES = ['ok', 'failed', 'aborted', 'monitor_abort', 'skipped'] as const;

/**
 * Reads histogram buckets from a list of numbers in seconds.
 * @param list Numbers separated by spaces.
 * @returns The numbers.
 */
function bucketsOf(list: string): number[] {
  return list.split(' ').map(Number);
}

const STAGE_BUCKETS = bucketsOf('0.1 0.25 0.5 1 2.5 5 10 20 30 60 120 300');
const LATENCY_BUCKETS = bucketsOf('0.25 0.5 1 2 5 10 20 30 60 120 180');

/** Value of the `status` label of `runs_total`. */
type RunStatusLabel = (typeof RUN_STATUSES)[number];

/** What `createMetrics` needs. */
export interface MetricsOptions {
  /** Version of the service, for `build_info`. */
  version: string;
  /** Receives rows that cannot be counted. */
  logger: Logger;
  /** Set to false to leave out the default process metrics; true by default. */
  collectDefault?: boolean;
}

/** The metrics of the monitor and the ways to feed them. */
export interface MonitorMetrics {
  /** Registry that `GET /metrics` prints. */
  registry: Registry;
  /**
   * Counts a finished row; never throws.
   * @param row Finished row, whatever its status.
   * @param result Full result, when the run produced one.
   */
  onRunFinished(row: RunRow, result: RunResult | undefined): void;
  /**
   * Sets the counters to zero and the last-run gauges from the history; called once at serve start and never throws.
   * @param history History to restore from.
   * @param scenarios Enabled scenarios.
   * @param intervalOf Interval of a scenario in milliseconds.
   */
  initialize(history: History, scenarios: readonly ScenarioName[], intervalOf: (scenario: ScenarioName) => number): void;
  /**
   * Sets the age of the oldest unsent alert.
   * @param seconds Age in seconds, 0 when the queue is empty.
   */
  setAlertBacklog(seconds: number): void;
  /** Counts a ping that did not reach the heartbeat service. */
  heartbeatFailed(): void;
  /** Stops the observers and monitors the default metrics started; safe to call again. */
  stop(): void;
}

/**
 * Tells whether a value is one of the allowed labels.
 * @param list Allowed values.
 * @param value Value to check.
 * @returns True when the list holds it.
 */
function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return list.includes(value as T);
}

/**
 * Names the `status` label of a row.
 * @param row Finished row.
 * @returns The status, with a stop or restart of the monitor apart from other aborts; undefined for a row still running.
 */
function statusLabel(row: RunRow): RunStatusLabel | undefined {
  if (isMonitorAbort(row)) {
    return 'monitor_abort';
  }

  return row.status === 'running' ? undefined : row.status;
}

/**
 * Gives the value of `last_status` for a row that carries a verdict.
 * @param row Row with status `ok`, `failed` or `aborted`.
 * @returns 1 for `ok`, 0.5 for `ok` with a degradation, 0 otherwise.
 */
function statusValue(row: RunRow): number {
  if (row.status !== 'ok') {
    return 0;
  }

  return row.degraded.length > 0 ? DEGRADED_STATUS : 1;
}

/**
 * Gives the time a row counts for in `last_run_timestamp_seconds`.
 * @param row Row that carries a verdict.
 * @returns Seconds since the epoch of its end, or of its start when it has no end.
 */
function timestampOf(row: RunRow): number {
  return Date.parse(row.finishedAt ?? row.startedAt) / MS_PER_SECOND;
}

/**
 * Registers the default process metrics and returns what stops what they start.
 * The library keeps its garbage collection observer and its event loop monitor to itself, so the two constructors are wrapped for the moment of the call to catch them.
 * @param registry Registry that gets the metrics.
 * @returns Functions that disconnect the observers and disable the monitors.
 */
function collectWithStoppers(registry: Registry): Array<() => void> {
  const stoppers: Array<() => void> = [];
  const { PerformanceObserver, monitorEventLoopDelay } = perfHooks;

  Reflect.set(perfHooks, 'PerformanceObserver', class extends PerformanceObserver {
    /**
     * Creates the observer and remembers how to stop it.
     * @param callback Receives the entries.
     */
    constructor(callback: ConstructorParameters<typeof PerformanceObserver>[0]) {
      super(callback);
      stoppers.push(() => {
        this.disconnect();
      });
    }
  });
  Reflect.set(perfHooks, 'monitorEventLoopDelay', (options?: Parameters<typeof monitorEventLoopDelay>[0]) => {
    const monitor = monitorEventLoopDelay(options);

    stoppers.push(() => {
      monitor.disable();
    });

    return monitor;
  });

  try {
    collectDefaultMetrics({ register: registry,
      prefix: PREFIX });
  } finally {
    Reflect.set(perfHooks, 'PerformanceObserver', PerformanceObserver);
    Reflect.set(perfHooks, 'monitorEventLoopDelay', monitorEventLoopDelay);
  }

  return stoppers;
}

/**
 * Creates the metrics with a registry of their own.
 * @param options Version, logger and the switch of the process metrics.
 * @returns Registry and the functions that feed it.
 */
export function createMetrics(options: MetricsOptions): MonitorMetrics {
  const { logger } = options;
  const registry = new Registry();
  const registers = [registry];
  const runs = new Counter({ name: `${PREFIX}runs_total`,
    help: 'Finished runs by status and trigger.',
    labelNames: ['scenario', 'status', 'trigger'],
    registers });
  const failures = new Counter({ name: `${PREFIX}failures_total`,
    help: 'Failed runs by stage, error class and culprit.',
    labelNames: ['scenario', 'stage', 'error_class', 'culprit'],
    registers });
  const degraded = new Counter({ name: `${PREFIX}degraded_total`,
    help: 'Ok runs with a degradation, by code.',
    labelNames: ['scenario', 'code'],
    registers });
  const runDuration = new Histogram({ name: `${PREFIX}run_duration_seconds`,
    help: 'Duration of a run.',
    labelNames: ['scenario'],
    buckets: STAGE_BUCKETS,
    registers });
  const stageDuration = new Histogram({ name: `${PREFIX}stage_duration_seconds`,
    help: 'Duration of a stage.',
    labelNames: ['scenario', 'stage', 'status'],
    buckets: STAGE_BUCKETS,
    registers });
  const eventLatency = new Histogram({ name: `${PREFIX}event_latency_seconds`,
    help: 'Time from the answer of the collector to the first sighting of the event.',
    labelNames: ['scenario', 'transport'],
    buckets: LATENCY_BUCKETS,
    registers });
  const notificationLatency = new Histogram({ name: `${PREFIX}notification_latency_seconds`,
    help: 'Time from the answer of the collector to the first notification.',
    labelNames: ['channel'],
    buckets: LATENCY_BUCKETS,
    registers });
  const lastRun = new Gauge({ name: `${PREFIX}last_run_timestamp_seconds`,
    help: 'End of the last run that carries a verdict.',
    labelNames: ['scenario'],
    registers });
  const interval = new Gauge({ name: `${PREFIX}scenario_interval_seconds`,
    help: 'Configured time between runs of a scenario.',
    labelNames: ['scenario'],
    registers });
  const lastStatus = new Gauge({ name: `${PREFIX}last_status`,
    help: 'Result of the last run: 1 ok, 0.5 ok with a degradation, 0 failed or hung.',
    labelNames: ['scenario'],
    registers });
  const backlog = new Gauge({ name: `${PREFIX}alert_backlog_seconds`,
    help: 'Age of the oldest alert that is not delivered.',
    registers });
  const heartbeatFailures = new Counter({ name: `${PREFIX}heartbeat_failures_total`,
    help: 'Pings that did not reach the heartbeat service.',
    registers });
  const buildInfo = new Gauge({ name: `${PREFIX}build_info`,
    help: 'Version of the service.',
    labelNames: ['version'],
    registers });

  buildInfo.set({ version: options.version }, 1);
  backlog.set(0);

  const stoppers: Array<() => void> = [];

  if (options.collectDefault !== false) {
    stoppers.push(...collectWithStoppers(registry));
  }

  const skip = (what: string, row: RunRow): void => {
    logger.warn(`metric not counted: ${what}`, { runId: row.runId,
      scenario: row.scenario });
  };

  const countFailure = (row: RunRow, scenario: ScenarioName): void => {
    const stage = row.failedStage ?? NO_STAGE;

    if (row.errorClass === undefined || !isOneOf(ERROR_CLASSES, row.errorClass)) {
      skip(`unknown error class ${String(row.errorClass)}`, row);

      return;
    }

    if (row.culprit === undefined || !isOneOf(CULPRITS, row.culprit) || !isOneOf([...STAGE_NAMES, NO_STAGE], stage)) {
      skip(`unknown culprit ${String(row.culprit)} or stage ${stage}`, row);

      return;
    }

    failures.inc(Object.fromEntries([['scenario', scenario], ['stage', stage], ['error_class', row.errorClass], ['culprit', row.culprit]]));
  };

  const observeResult = (scenario: ScenarioName, result: RunResult): void => {
    runDuration.observe({ scenario }, result.durationMs / MS_PER_SECOND);

    for (const stage of result.stages) {
      if (stage.status !== 'skipped' && isOneOf(STAGE_NAMES, stage.name) && isOneOf(STAGE_STATUSES, stage.status)) {
        stageDuration.observe({ scenario,
          stage: stage.name,
          status: stage.status }, stage.durationMs / MS_PER_SECOND);
      }
    }

    if (result.eventLatencyMs !== undefined && result.transport !== undefined && isOneOf(TRANSPORTS, result.transport)) {
      eventLatency.observe({ scenario,
        transport: result.transport }, result.eventLatencyMs / MS_PER_SECOND);
    }

    for (const channel of CHANNELS) {
      const latencyMs = result.notification?.[channel]?.latencyMs;

      if (latencyMs !== undefined) {
        notificationLatency.observe({ channel }, latencyMs / MS_PER_SECOND);
      }
    }
  };

  const count = (row: RunRow, result: RunResult | undefined): void => {
    const status = statusLabel(row);

    if (!isOneOf(SCENARIO_NAMES, row.scenario) || status === undefined || !isOneOf(RUN_TRIGGERS, row.trigger)) {
      skip(`unknown scenario ${row.scenario}, status or trigger`, row);

      return;
    }

    runs.inc({ scenario: row.scenario,
      status,
      trigger: row.trigger });

    if (status === 'failed' || status === 'aborted') {
      countFailure(row, row.scenario);
    }

    for (const code of row.degraded) {
      if (isOneOf(DEGRADED_CODES, code)) {
        degraded.inc({ scenario: row.scenario,
          code });
      }
    }

    if (isVerdict(row)) {
      lastRun.set({ scenario: row.scenario }, timestampOf(row));
    }

    if (isVerdict(row, { aborts: true,
      warmup: false })) {
      lastStatus.set({ scenario: row.scenario }, statusValue(row));
    }

    if (result !== undefined) {
      observeResult(row.scenario, result);
    }
  };

  const onRunFinished: MonitorMetrics['onRunFinished'] = (row, result) => {
    try {
      count(row, result);
    } catch (error) {
      logger.error('metrics could not count a run', { runId: row.runId,
        error });
    }
  };

  const restore = (history: History, scenario: ScenarioName): void => {
    const verdict = history.lastVerdict(scenario);
    const status = history.lastVerdict(scenario, { aborts: true,
      warmup: false });

    if (verdict !== undefined) {
      lastRun.set({ scenario }, timestampOf(verdict));
    }

    if (status !== undefined) {
      lastStatus.set({ scenario }, statusValue(status));
    }
  };

  const initialize: MonitorMetrics['initialize'] = (history, scenarios, intervalOf) => {
    for (const scenario of scenarios) {
      for (const status of RUN_STATUSES) {
        for (const trigger of RUN_TRIGGERS) {
          runs.inc({ scenario,
            status,
            trigger }, 0);
        }
      }

      for (const code of DEGRADED_CODES) {
        degraded.inc({ scenario,
          code }, 0);
      }

      interval.set({ scenario }, intervalOf(scenario) / MS_PER_SECOND);

      try {
        restore(history, scenario);
      } catch (error) {
        logger.error('metrics could not read the last run from the history', { scenario,
          error });
      }
    }
  };

  const setAlertBacklog: MonitorMetrics['setAlertBacklog'] = (seconds) => {
    backlog.set(seconds);
  };

  const heartbeatFailed: MonitorMetrics['heartbeatFailed'] = () => {
    heartbeatFailures.inc();
  };

  const stop: MonitorMetrics['stop'] = () => {
    for (const stopper of stoppers.splice(0)) {
      stopper();
    }
  };

  return {
    registry,
    onRunFinished,
    initialize,
    setAlertBacklog,
    heartbeatFailed,
    stop,
  };
}
