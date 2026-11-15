import { describe, expect, it } from 'vitest';
import { TEST_RECEIVER_SECRET, validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { describeConfig } from '../../src/config/describe.js';
import { loadConfig } from '../../src/config/load.js';

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
  it('uses the default monitoring settings', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ ...NOTIFICATION_ENV,
      SCENARIOS: undefined }))).config;

    expect(monitoring).toEqual({
      scenarios: ['send-and-receive-event', 'check-notification', 'sourcemaps', 'sentry-envelope'],
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
      heartbeat: { intervalMs: 60_000 },
      probe: { intervalMs: 90_000,
        alertAfterFailures: 3,
        retentionDays: 7 },
      manual: { minIntervalMs: 60_000 },
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

  it('uses the default settings of the scenarios with their own variables', () => {
    expect(expectOk(loadConfig(validEnv())).config.scenarios).toEqual({
      newProject: { intervalMs: 86_400_000,
        tokenTimeoutMs: 180_000 },
      sourcemaps: { intervalMs: 3_600_000,
        releaseSaveTimeoutMs: 60_000 },
      sentryEnvelope: { intervalMs: 3_600_000 },
      telegramDelivery: { intervalMs: 3_600_000,
        senderUsername: 'codex_bot',
        apiUrl: 'https://api.telegram.org',
        deliveryTimeoutMs: 120_000,
        probeTimeoutMs: 30_000 },
    });
  });

  it('reads the variables of the scenarios', () => {
    const { scenarios } = expectOk(loadConfig(validEnv({ NEW_PROJECT_INTERVAL_MS: '90000000',
      NEW_PROJECT_TOKEN_TIMEOUT_MS: '1000',
      SOURCEMAPS_INTERVAL_MS: '4000000',
      RELEASE_SAVE_TIMEOUT_MS: '2000',
      SENTRY_ENVELOPE_INTERVAL_MS: '5000000' }))).config;

    expect(scenarios).toEqual({ newProject: { intervalMs: 90_000_000,
      tokenTimeoutMs: 1000 },
    sourcemaps: { intervalMs: 4_000_000,
      releaseSaveTimeoutMs: 2000 },
    sentryEnvelope: { intervalMs: 5_000_000 },
    telegramDelivery: { intervalMs: 3_600_000,
      senderUsername: 'codex_bot',
      apiUrl: 'https://api.telegram.org',
      deliveryTimeoutMs: 120_000,
      probeTimeoutMs: 30_000 } });
  });

  it('rejects zero and text in the variables of the scenarios', () => {
    for (const name of ['NEW_PROJECT_INTERVAL_MS', 'SOURCEMAPS_INTERVAL_MS', 'SENTRY_ENVELOPE_INTERVAL_MS', 'NEW_PROJECT_TOKEN_TIMEOUT_MS', 'RELEASE_SAVE_TIMEOUT_MS']) {
      expect(messagesOf({ [name]: '0' }, name)).toHaveLength(1);
      expect(messagesOf({ [name]: 'soon' }, name)).toHaveLength(1);
    }
  });

  it('the interval of a chosen scenario must exceed its watchdog', () => {
    // sentry-envelope: 15000 + 15000 + 10000 + 120000 + 30000 + 30000 = 220000 with the defaults.
    expect(messagesOf({ SCENARIOS: 'sentry-envelope',
      SENTRY_ENVELOPE_INTERVAL_MS: '220000' }, 'SENTRY_ENVELOPE_INTERVAL_MS')[0]).toContain('220000 ms');
    expectOk(loadConfig(validEnv({ SCENARIOS: 'sentry-envelope',
      SENTRY_ENVELOPE_INTERVAL_MS: '220001' })));
    // sourcemaps adds the upload (10000) and the save wait (60000).
    expect(messagesOf({ SCENARIOS: 'sourcemaps',
      SOURCEMAPS_INTERVAL_MS: '290000' }, 'SOURCEMAPS_INTERVAL_MS')).toHaveLength(1);
    expectOk(loadConfig(validEnv({ SCENARIOS: 'sourcemaps',
      SOURCEMAPS_INTERVAL_MS: '290001' })));
    // new-project: 15000 + 15000 + 180000 + 120000 + 30000 + 30000 = 390000.
    expect(messagesOf({ SCENARIOS: 'new-project',
      NEW_PROJECT_INTERVAL_MS: '390000' }, 'NEW_PROJECT_INTERVAL_MS')).toHaveLength(1);
    expectOk(loadConfig(validEnv({ SCENARIOS: 'new-project',
      NEW_PROJECT_INTERVAL_MS: '390001' })));
  });

  it('does not check the interval of a scenario that is not chosen', () => {
    expectOk(loadConfig(validEnv({ SENTRY_ENVELOPE_INTERVAL_MS: '1000' })));
  });

  it('rejects a repeated scenario', () => {
    expect(messagesOf({ ...NOTIFICATION_ENV,
      SCENARIOS: 'check-notification,check-notification' }, 'SCENARIOS')).not.toHaveLength(0);
  });

  it('rejects an unknown scenario and an empty element', () => {
    expect(messagesOf({ SCENARIOS: 'nope' }, 'SCENARIOS')[0]).toContain('send-and-receive-event');
    expect(messagesOf({ SCENARIOS: 'send-and-receive-event,' }, 'SCENARIOS')).not.toHaveLength(0);
  });

  it('loads without receiver settings, whichever scenarios are chosen', () => {
    const env = { RECEIVER_SECRET: undefined,
      SCENARIOS: undefined };

    expect(expectOk(loadConfig(validEnv(env))).config.monitoring.scenarios).toContain('check-notification');
    expectOk(loadConfig(validEnv({ ...env,
      SCENARIOS: 'check-notification' })));
  });

  it('CHECK_INTERVAL_MS must exceed the run, cleanup and grace', () => {
    // 480000 + 30000 + 30000 = 540000 with the defaults.
    expect(messagesOf({ CHECK_INTERVAL_MS: '540000' }, 'CHECK_INTERVAL_MS')[0])
      .toContain('RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS');
    expectOk(loadConfig(validEnv({ CHECK_INTERVAL_MS: '540001' })));
  });

  it('RULE_CACHE_WARMUP_MS plus the margin must stay below CHECK_INTERVAL_MS with check-notification', () => {
    const env = { ...NOTIFICATION_ENV,
      SCENARIOS: 'check-notification',
      CHECK_INTERVAL_MS: '600000' };

    expect(messagesOf({ ...env,
      RULE_CACHE_WARMUP_MS: '599000' }, 'RULE_CACHE_WARMUP_MS'))
      .toEqual(['must be less than CHECK_INTERVAL_MS - 1000 ms (599000 ms)']);
    expectOk(loadConfig(validEnv({ ...env,
      RULE_CACHE_WARMUP_MS: '598999' })));
  });

  it('does not judge RULE_CACHE_WARMUP_MS without check-notification', () => {
    expectOk(loadConfig(validEnv({ CHECK_INTERVAL_MS: '600000',
      RULE_CACHE_WARMUP_MS: '599000' })));
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
