import perfHooks from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../src/metrics/metrics.js';
import type { MonitorMetrics } from '../../src/metrics/metrics.js';
import { TRANSPORTS } from '../../src/clients/collector.js';
import { CHANNELS } from '../../src/notifications/types.js';
import { SCENARIO_NAMES } from '../../src/scenarios/names.js';
import { STAGE_NAMES } from '../../src/engine/result.js';
import { CULPRITS, ERROR_CLASSES } from '../../src/errors/taxonomy.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import { DEGRADED_CODES, RUN_TRIGGERS } from '../../src/storage/types.js';
import type { RunOutcome, RunRow } from '../../src/storage/types.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';
import { runResultFixture, stageFixture } from '../support/run-result.js';

const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';
const FINISHED = '2026-03-10T10:00:05.000Z';
const STARTED = '2026-03-10T10:00:00.000Z';
const INTERVAL_MS = 600_000;

/** One series as `getMetricsAsJSON` returns it. */
interface Series {
  /** Labels of the series. */
  labels: Record<string, string | number>;
  /** Value of the series. */
  value: number;
  /** Name of the sample, for histograms. */
  metricName?: string;
}

/** One metric as `getMetricsAsJSON` returns it. */
interface Family {
  /** Name. */
  name: string;
  /** Series. */
  values: Series[];
}

/** Metrics of a test with the log they write to. */
interface Fixture {
  /** The metrics under test. */
  metrics: MonitorMetrics;
  /** Log of the metrics. */
  logger: MemoryLogger;
  /** Reads a value; undefined when the series does not exist. */
  read: (name: string, labels?: Record<string, string>) => Promise<number | undefined>;
  /** All hawk_e2e series without the default ones. */
  families: () => Promise<Family[]>;
}

/**
 * Creates metrics with a registry of their own and no default process metrics.
 * @returns The metrics and readers.
 */
function fixture(): Fixture {
  const logger = memoryLogger();
  const metrics = createMetrics({ version: '9.9.9',
    logger,
    collectDefault: false });
  const families = async (): Promise<Family[]> => (await metrics.registry.getMetricsAsJSON()) as unknown as Family[];
  const read: Fixture['read'] = async (name, labels = {}) => {
    const family = (await families()).find(item => item.name === name);
    const found = family?.values.filter(series => series.metricName === undefined || series.metricName === `${name}_count` || series.metricName === name)
      .find(series => Object.entries(labels).every(([key, value]) => series.labels[key] === value));

    return found?.value;
  };

  return { metrics,
    logger,
    read,
    families };
}

/**
 * Builds a finished row.
 * @param overrides Values that differ from the ok row.
 * @returns Row with the given values.
 */
function row(overrides: Partial<RunRow> = {}): RunRow {
  return { id: 1,
    runId: 'raaaaaaaaaaaaaaaa',
    scenario: SEND,
    sequence: 1,
    trigger: 'schedule',
    status: 'ok',
    startedAt: STARTED,
    finishedAt: FINISHED,
    durationMs: 5000,
    degraded: [],
    stages: [],
    ...overrides };
}

/**
 * Converts a time to seconds since the epoch.
 * @param iso Moment to convert, as text.
 * @returns Whole and fractional seconds.
 */
function seconds(iso: string): number {
  return Date.parse(iso) / 1000;
}

describe('onRunFinished', () => {
  it('counts a failed run with its stage, class and culprit', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk' }), runResultFixture({ status: 'failed' }));

    expect(await read('hawk_e2e_runs_total', { scenario: SEND,
      status: 'failed',
      trigger: 'schedule' })).toBe(1);
    expect(await read('hawk_e2e_failures_total', Object.fromEntries([['scenario', SEND], ['stage', 'event_visible'], ['error_class', 'event_not_found'], ['culprit', 'hawk']]))).toBe(1);
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(0);
    expect(await read('hawk_e2e_last_run_timestamp_seconds', { scenario: SEND })).toBe(seconds(FINISHED));
  });

  it('counts a hung run as aborted with the stage none and sets last_status to 0', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row({ status: 'ok' }), runResultFixture());
    metrics.onRunFinished(row({ status: 'aborted',
      errorClass: 'run_hung',
      culprit: 'monitor' }), undefined);

    expect(await read('hawk_e2e_runs_total', { status: 'aborted' })).toBe(1);
    expect(await read('hawk_e2e_failures_total', Object.fromEntries([['stage', 'none'], ['error_class', 'run_hung'], ['culprit', 'monitor']]))).toBe(1);
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(0);
  });

  it('counts a stop of the monitor as monitor_abort and leaves last_status and the failures alone', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row(), runResultFixture());
    metrics.onRunFinished(row({ status: 'aborted',
      errorClass: 'monitor_stopped',
      culprit: 'monitor' }), undefined);
    metrics.onRunFinished(row({ status: 'aborted',
      errorClass: 'monitor_restarted',
      culprit: 'monitor' }), undefined);

    expect(await read('hawk_e2e_runs_total', { status: 'monitor_abort' })).toBe(2);
    expect(await read('hawk_e2e_runs_total', { status: 'aborted' })).toBeUndefined();
    expect(await read('hawk_e2e_failures_total')).toBeUndefined();
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(1);
  });

  it('treats the warmup skip as a verdict for the timestamp but not for last_status', async () => {
    const { metrics, read } = fixture();
    const later = '2026-03-10T11:00:05.000Z';

    metrics.onRunFinished(row(), runResultFixture());
    metrics.onRunFinished(row({ status: 'skipped',
      skipReason: 'rule_cache_warmup',
      finishedAt: later }), runResultFixture());

    expect(await read('hawk_e2e_runs_total', { status: 'skipped' })).toBe(1);
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(1);
    expect(await read('hawk_e2e_last_run_timestamp_seconds', { scenario: SEND })).toBe(seconds(later));
  });

  it('ignores an overlap skip for the timestamp and last_status', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row({ status: 'skipped',
      skipReason: 'overlap',
      finishedAt: '2026-03-10T12:00:00.000Z' }), undefined);

    expect(await read('hawk_e2e_runs_total', { status: 'skipped' })).toBe(1);
    expect(await read('hawk_e2e_last_run_timestamp_seconds', { scenario: SEND })).toBeUndefined();
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBeUndefined();
  });

  it('sets last_status to 0.5 for an ok run with a degradation and counts the code', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row({ degraded: ['quota_usage'] }), runResultFixture());

    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(0.5);
    expect(await read('hawk_e2e_degraded_total', { scenario: SEND,
      code: 'quota_usage' })).toBe(1);
  });

  it('labels the runs of a manual trigger', async () => {
    const { metrics, read } = fixture();

    metrics.onRunFinished(row({ trigger: 'manual' }), runResultFixture());

    expect(await read('hawk_e2e_runs_total', { trigger: 'manual',
      status: 'ok' })).toBe(1);
  });

  it('observes the run, the stages, the event latency and the notification latencies', async () => {
    const { metrics, families } = fixture();

    metrics.onRunFinished(row({ scenario: NOTIFY }), runResultFixture({ scenario: NOTIFY,
      transport: 'ws',
      eventLatencyMs: 1500,
      durationMs: 5000,
      stages: [stageFixture('collector_availability', 'ok', 200),
        stageFixture('event_visible', 'ok', 1500),
        stageFixture('event_repeated', 'skipped', 0)],
      notification: { webhook: { latencyMs: 2000 },
        loop: { latencyMs: 3000 },
        unmatched: 0 } }));

    const sum = async (name: string, labels: Record<string, string>): Promise<number | undefined> => {
      const family = (await families()).find(item => item.name === name);

      return family?.values.find(series => series.metricName === `${name}_sum` && Object.entries(labels).every(([key, value]) => series.labels[key] === value))?.value;
    };

    expect(await sum('hawk_e2e_run_duration_seconds', { scenario: NOTIFY })).toBe(5);
    expect(await sum('hawk_e2e_stage_duration_seconds', { scenario: NOTIFY,
      stage: 'event_visible',
      status: 'ok' })).toBe(1.5);
    expect(await sum('hawk_e2e_stage_duration_seconds', { stage: 'event_repeated' })).toBeUndefined();
    expect(await sum('hawk_e2e_event_latency_seconds', { scenario: NOTIFY,
      transport: 'ws' })).toBe(1.5);
    expect(await sum('hawk_e2e_notification_latency_seconds', { channel: 'webhook' })).toBe(2);
    expect(await sum('hawk_e2e_notification_latency_seconds', { channel: 'loop' })).toBe(3);
  });

  it('writes no event latency when the result has no transport', async () => {
    const { metrics, families } = fixture();
    const { transport: _transport, ...result } = runResultFixture({ eventLatencyMs: 1500 });

    metrics.onRunFinished(row(), result);

    const family = (await families()).find(item => item.name === 'hawk_e2e_event_latency_seconds');

    expect(family?.values ?? []).toEqual([]);
  });

  it('keeps every label value inside the lists', async () => {
    const { metrics, families } = fixture();
    const result = runResultFixture({ transport: 'http',
      eventLatencyMs: 100,
      notification: { webhook: { latencyMs: 1 },
        loop: { latencyMs: 2 },
        unmatched: 0 },
      stages: [stageFixture('api_availability'), stageFixture('cleanup', 'failed')] });

    metrics.onRunFinished(row({ degraded: ['single_channel'] }), result);
    metrics.onRunFinished(row({ status: 'failed',
      failedStage: 'cleanup',
      errorClass: 'cleanup_failed',
      culprit: 'hawk',
      trigger: 'manual' }), result);
    metrics.onRunFinished(row({ status: 'aborted',
      errorClass: 'run_hung',
      culprit: 'monitor' }), undefined);
    metrics.onRunFinished(row({ status: 'aborted',
      errorClass: 'monitor_stopped',
      culprit: 'monitor' }), undefined);
    metrics.onRunFinished(row({ status: 'skipped',
      skipReason: 'overlap' }), undefined);

    const allowed = new Map<string, readonly string[]>([
      ['scenario', SCENARIO_NAMES],
      ['status', ['ok', 'failed', 'aborted', 'monitor_abort', 'skipped', 'uncertain']],
      ['trigger', RUN_TRIGGERS],
      ['stage', [...STAGE_NAMES, 'none']],
      ['error_class', ERROR_CLASSES],
      ['culprit', CULPRITS],
      ['code', DEGRADED_CODES],
      ['transport', TRANSPORTS],
      ['channel', CHANNELS],
      ['version', ['9.9.9']],
    ]);

    for (const family of await families()) {
      for (const series of family.values) {
        for (const [label, value] of Object.entries(series.labels)) {
          if (label !== 'le') {
            expect(allowed.get(label), `${family.name} has the label ${label}`).toContain(String(value));
          }
        }
      }
    }
  });

  it('does not throw on a row with an unknown class, skips the series and logs it', async () => {
    const { metrics, read, logger } = fixture();
    const strange = row({ status: 'failed',
      errorClass: 'no_such_class' as RunRow['errorClass'],
      culprit: 'hawk' });

    expect(() => {
      metrics.onRunFinished(strange, undefined);
    }).not.toThrow();
    expect(await read('hawk_e2e_failures_total')).toBeUndefined();
    expect(logger.lines.some(line => line.level === 'warn' && String(line.msg).includes('no_such_class'))).toBe(true);
  });

  it('does not throw on a row of an unknown scenario', () => {
    const { metrics } = fixture();

    expect(() => {
      metrics.onRunFinished(row({ scenario: 'nothing' as RunRow['scenario'] }), undefined);
    }).not.toThrow();
  });
});

describe('other metrics', () => {
  it('exposes build_info, the alert backlog and the heartbeat failures', async () => {
    const { metrics, read } = fixture();

    expect(await read('hawk_e2e_build_info', { version: '9.9.9' })).toBe(1);
    expect(await read('hawk_e2e_alert_backlog_seconds')).toBe(0);
    expect(await read('hawk_e2e_heartbeat_failures_total')).toBe(0);

    metrics.setAlertBacklog(42);
    metrics.heartbeatFailed();

    expect(await read('hawk_e2e_alert_backlog_seconds')).toBe(42);
    expect(await read('hawk_e2e_heartbeat_failures_total')).toBe(1);
  });

  it('registers the default process metrics with the prefix unless switched off', async () => {
    const withDefaults = createMetrics({ version: '1',
      logger: memoryLogger() });
    const text = await withDefaults.registry.metrics();

    expect(text).toContain('hawk_e2e_process_cpu_user_seconds_total');
  });
});

/**
 * Stores a finished run.
 * @param history History to write to.
 * @param runId Random id the run gets.
 * @param sequence Number of the run in its scenario.
 * @param startedAt Start of the run, ISO.
 * @param scenario Scenario the run belongs to.
 * @param outcome Fields to change in the ok outcome.
 */
function store(history: History, runId: string, sequence: number, startedAt: string, scenario: RunRow['scenario'], outcome: Partial<RunOutcome> = {}): void {
  history.startRun({ runId,
    scenario,
    sequence,
    trigger: 'schedule',
    startedAt });
  history.finishRun(runId, { status: 'ok',
    finishedAt: new Date(Date.parse(startedAt) + 5000).toISOString(),
    durationMs: 5000,
    degraded: [],
    ...outcome });
}

describe('initialize', () => {
  it('zeroes the run and degradation counters of the enabled scenarios and sets their intervals', async () => {
    const { metrics, read } = fixture();

    metrics.initialize(createHistory(openDatabase(':memory:')), [SEND], () => INTERVAL_MS);

    for (const status of ['ok', 'failed', 'aborted', 'monitor_abort', 'skipped']) {
      for (const trigger of RUN_TRIGGERS) {
        expect(await read('hawk_e2e_runs_total', { scenario: SEND,
          status,
          trigger })).toBe(0);
      }
    }

    for (const code of DEGRADED_CODES) {
      expect(await read('hawk_e2e_degraded_total', { scenario: SEND,
        code })).toBe(0);
    }

    expect(await read('hawk_e2e_runs_total', { scenario: NOTIFY })).toBeUndefined();
    expect(await read('hawk_e2e_scenario_interval_seconds', { scenario: SEND })).toBe(INTERVAL_MS / 1000);
    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBeUndefined();
    expect(await read('hawk_e2e_failures_total')).toBeUndefined();
  });

  it('restores last_status and the timestamp from the newest verdicts of the history', async () => {
    const { metrics, read } = fixture();
    const history = createHistory(openDatabase(':memory:'));

    store(history, 'ok1', 1, '2026-03-10T10:00:00.000Z', SEND);
    store(history, 'warm', 2, '2026-03-10T10:10:00.000Z', SEND, { status: 'skipped',
      skipReason: 'rule_cache_warmup' });
    history.recordSkip({ runId: 'ov',
      scenario: SEND,
      sequence: 3,
      trigger: 'schedule',
      at: '2026-03-10T10:20:00.000Z',
      reason: 'overlap' });
    store(history, 'bad', 1, '2026-03-10T09:00:00.000Z', NOTIFY, { status: 'aborted',
      errorClass: 'run_hung',
      culprit: 'monitor' });
    store(history, 'stop', 2, '2026-03-10T09:30:00.000Z', NOTIFY, { status: 'aborted',
      errorClass: 'monitor_stopped',
      culprit: 'monitor' });

    metrics.initialize(history, [SEND, NOTIFY], () => INTERVAL_MS);

    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(1);
    expect(await read('hawk_e2e_last_run_timestamp_seconds', { scenario: SEND })).toBe(seconds('2026-03-10T10:10:05.000Z'));
    expect(await read('hawk_e2e_last_status', { scenario: NOTIFY })).toBe(0);
    expect(await read('hawk_e2e_last_run_timestamp_seconds', { scenario: NOTIFY })).toBeUndefined();
  });

  it('restores 0.5 for an ok run with a degradation', async () => {
    const { metrics, read } = fixture();
    const history = createHistory(openDatabase(':memory:'));

    store(history, 'deg', 1, STARTED, SEND, { degraded: ['quota_usage'] });
    metrics.initialize(history, [SEND], () => INTERVAL_MS);

    expect(await read('hawk_e2e_last_status', { scenario: SEND })).toBe(0.5);
  });

  it('logs and goes on when the history cannot be read', async () => {
    const { metrics, logger, read } = fixture();
    const history = createHistory(openDatabase(':memory:'));

    history.close();

    expect(() => {
      metrics.initialize(history, [SEND], () => INTERVAL_MS);
    }).not.toThrow();
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
    expect(await read('hawk_e2e_runs_total', { scenario: SEND,
      status: 'ok',
      trigger: 'schedule' })).toBe(0);
  });
});

/** An observer that can be disconnected. */
interface Disconnectable {
  /** Stops the observer. */
  disconnect: () => void;
}

/** A monitor that can be disabled. */
interface Disablable {
  /** Stops the monitor. */
  disable: () => boolean;
}

/** Options of `monitorEventLoopDelay`. */
type MonitorOptions = Parameters<typeof perfHooks.monitorEventLoopDelay>[0];

describe('stop', () => {
  it('disconnects the observers and disables the monitors the default metrics start, and may be called twice', () => {
    const real = { observer: perfHooks.PerformanceObserver,
      monitor: perfHooks.monitorEventLoopDelay };
    const observers: Disconnectable[] = [];
    const monitors: Disablable[] = [];

    Reflect.set(perfHooks, 'PerformanceObserver', class extends real.observer {
      /**
       * Creates the observer and keeps it for the test.
       * @param callback Receives the entries.
       */
      constructor(callback: ConstructorParameters<typeof real.observer>[0]) {
        super(callback);
        observers.push(this);
      }
    });
    Reflect.set(perfHooks, 'monitorEventLoopDelay', (options?: MonitorOptions) => {
      const monitor = real.monitor(options);

      monitors.push(monitor);

      return monitor;
    });

    let metrics: MonitorMetrics;

    try {
      metrics = createMetrics({ version: '1',
        logger: memoryLogger() });
    } finally {
      Reflect.set(perfHooks, 'PerformanceObserver', real.observer);
      Reflect.set(perfHooks, 'monitorEventLoopDelay', real.monitor);
    }

    expect(observers.length).toBeGreaterThan(0);
    expect(monitors.length).toBeGreaterThan(0);

    const disconnect = observers.map(observer => vi.spyOn(observer, 'disconnect'));
    const disable = monitors.map(monitor => vi.spyOn(monitor, 'disable'));

    metrics.stop();
    metrics.stop();

    for (const spy of [...disconnect, ...disable]) {
      expect(spy).toHaveBeenCalled();
    }
  });

  it('is harmless without the default metrics', () => {
    const { metrics } = fixture();

    expect(() => {
      metrics.stop();
    }).not.toThrow();
  });
});
