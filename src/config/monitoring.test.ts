import { describe, expect, it } from 'vitest';
import { TEST_RECEIVER_SECRET, validEnv } from '../test-support/env.js';
import { expectErrors, expectOk } from '../test-support/result.js';
import { describeConfig } from './describe.js';
import { loadConfig } from './load.js';

const NOTIFICATION_ENV = { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
  PUBLIC_BASE_URL: 'https://monitor.example.test' };

/**
 * Loads the env and returns the errors of one variable.
 * @param overrides Variables to set.
 * @param variable Variable whose messages are wanted.
 * @returns Messages of that variable.
 */
function messagesOf(overrides: Record<string, string | undefined>, variable: string): string[] {
  return expectErrors(loadConfig(validEnv(overrides)))
    .filter(error => error.variable === variable)
    .map(error => error.message);
}

describe('monitoring configuration', () => {
  it('uses the defaults of the spec', () => {
    const { monitoring } = expectOk(loadConfig(validEnv())).config;

    expect(monitoring).toEqual({
      scenarios: ['send-and-receive-event'],
      intervalMs: 600_000,
      watchdogGraceMs: 30_000,
      staggerMs: 30_000,
      tunnelReadyTimeoutMs: 120_000,
      databasePath: 'data/monitor.db',
      retentionDays: 30,
      alertAfterFailures: 1,
      alertRetryMs: 60_000,
      sweepIntervalMs: 3_600_000,
      sweepMinAgeMs: 900_000,
    });
  });

  it('reads every variable', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ ...NOTIFICATION_ENV,
      SCENARIOS: 'check-notification, send-and-receive-event',
      CHECK_INTERVAL_MS: '700000',
      WATCHDOG_GRACE_MS: '1000',
      SCENARIO_STAGGER_MS: '0',
      TUNNEL_READY_TIMEOUT_MS: '0',
      DATABASE_PATH: '/tmp/x.db',
      HISTORY_RETENTION_DAYS: '3650',
      ALERT_NOTIFY_URL: 'https://notify.example.test/u/abc',
      ALERT_AFTER_FAILURES: '10',
      ALERT_RETRY_MS: '1000',
      SWEEP_INTERVAL_MS: '0',
      SWEEP_MIN_AGE_MS: '600000' }))).config;

    expect(monitoring.scenarios).toEqual(['check-notification', 'send-and-receive-event']);
    expect(monitoring).toMatchObject({ intervalMs: 700_000,
      watchdogGraceMs: 1000,
      staggerMs: 0,
      tunnelReadyTimeoutMs: 0,
      databasePath: '/tmp/x.db',
      retentionDays: 3650,
      alertNotifyUrl: 'https://notify.example.test/u/abc',
      alertAfterFailures: 10,
      alertRetryMs: 1000,
      sweepIntervalMs: 0,
      sweepMinAgeMs: 600_000 });
  });

  it('rejects a repeated scenario', () => {
    expect(messagesOf({ ...NOTIFICATION_ENV,
      SCENARIOS: 'check-notification,check-notification' }, 'SCENARIOS')).not.toHaveLength(0);
  });

  it('rejects an unknown scenario and an empty element', () => {
    expect(messagesOf({ SCENARIOS: 'nope' }, 'SCENARIOS')[0]).toContain('send-and-receive-event');
    expect(messagesOf({ SCENARIOS: 'send-and-receive-event,' }, 'SCENARIOS')).not.toHaveLength(0);
  });

  it('check-notification needs RECEIVER_SECRET', () => {
    expect(messagesOf({ SCENARIOS: 'check-notification',
      RECEIVER_SECRET: undefined,
      PUBLIC_BASE_URL: 'https://monitor.example.test' }, 'SCENARIOS')[0]).toContain('RECEIVER_SECRET');
  });

  it('check-notification needs an address source', () => {
    expect(messagesOf({ SCENARIOS: 'check-notification' }, 'SCENARIOS')[0]).toMatch(/PUBLIC_BASE_URL.*TUNNEL_METRICS_URL/u);
    expectOk(loadConfig(validEnv({ SCENARIOS: 'check-notification',
      TUNNEL_METRICS_URL: 'http://tunnel:2000' })));
  });

  it('CHECK_INTERVAL_MS must exceed the run, cleanup and grace', () => {
    // 480000 + 30000 + 30000 = 540000 with the defaults.
    expect(messagesOf({ CHECK_INTERVAL_MS: '540000' }, 'CHECK_INTERVAL_MS')[0])
      .toContain('RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS');
    expectOk(loadConfig(validEnv({ CHECK_INTERVAL_MS: '540001' })));
  });

  it('SCENARIO_STAGGER_MS must not exceed CHECK_INTERVAL_MS', () => {
    expect(messagesOf({ SCENARIO_STAGGER_MS: '600001' }, 'SCENARIO_STAGGER_MS')[0]).toContain('CHECK_INTERVAL_MS');
    expectOk(loadConfig(validEnv({ SCENARIO_STAGGER_MS: '600000' })));
  });

  it('SWEEP_MIN_AGE_MS must cover the run and cleanup', () => {
    expect(messagesOf({ SWEEP_MIN_AGE_MS: '509999' }, 'SWEEP_MIN_AGE_MS')[0]).toContain('RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS');
    expectOk(loadConfig(validEnv({ SWEEP_MIN_AGE_MS: '510000' })));
  });

  it('checks the ranges', () => {
    expect(messagesOf({ WATCHDOG_GRACE_MS: '999' }, 'WATCHDOG_GRACE_MS')).toHaveLength(1);
    expect(messagesOf({ WATCHDOG_GRACE_MS: '600001' }, 'WATCHDOG_GRACE_MS')).toHaveLength(1);
    expect(messagesOf({ TUNNEL_READY_TIMEOUT_MS: '600001' }, 'TUNNEL_READY_TIMEOUT_MS')).toHaveLength(1);
    expect(messagesOf({ HISTORY_RETENTION_DAYS: '0' }, 'HISTORY_RETENTION_DAYS')).toHaveLength(1);
    expect(messagesOf({ HISTORY_RETENTION_DAYS: '3651' }, 'HISTORY_RETENTION_DAYS')).toHaveLength(1);
    expect(messagesOf({ ALERT_AFTER_FAILURES: '0' }, 'ALERT_AFTER_FAILURES')).toHaveLength(1);
    expect(messagesOf({ ALERT_AFTER_FAILURES: '11' }, 'ALERT_AFTER_FAILURES')).toHaveLength(1);
    expect(messagesOf({ ALERT_RETRY_MS: '999' }, 'ALERT_RETRY_MS')).toHaveLength(1);
    expect(messagesOf({ ALERT_RETRY_MS: '3600001' }, 'ALERT_RETRY_MS')).toHaveLength(1);
    expect(messagesOf({ ALERT_NOTIFY_URL: 'http://notify.example.test/u/x' }, 'ALERT_NOTIFY_URL')).toHaveLength(1);
  });

  it('hides ALERT_NOTIFY_URL in the summary and shows the other variables', () => {
    const summary = describeConfig(expectOk(loadConfig(validEnv({ ALERT_NOTIFY_URL: 'https://notify.example.test/u/secret-token' }))).env);

    expect(summary.values.ALERT_NOTIFY_URL).toBe('***');
    expect(JSON.stringify(summary)).not.toContain('secret-token');
    expect(summary.values.DATABASE_PATH).toBe('data/monitor.db');
    expect(summary.values.CHECK_INTERVAL_MS).toBe('600000');
  });
});
