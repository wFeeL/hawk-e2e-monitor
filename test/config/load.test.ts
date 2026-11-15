import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { TEST_INTEGRATION_TOKEN, TEST_PROJECT_ID, TEST_RECEIVER_SECRET, validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { formatConfigErrors, loadConfig } from '../../src/config/load.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const { config } = expectOk(loadConfig(validEnv()));

    expect(config.logLevel).toBe('info');
    expect(config.internal).toEqual({ host: '127.0.0.1',
      port: 8090 });
    expect(config.shutdownTimeoutMs).toBe(5000);
    expect(config.healthCheckTimeoutMs).toBe(2000);
    expect(config.hawk.collectorUrl).toBe('http://localhost:3000/');
    expect(config.transportMode).toBe('alternate');
    expect(config.repeatEveryNRuns).toBe(6);
    expect(config.httpTimeoutMs).toBe(5000);
    expect(config.lateDuplicateWaitMs).toBe(5000);
    expect(config.timeouts).toEqual({
      collectorAvailability: 15_000,
      apiAvailability: 15_000,
      collectorAccept: 10_000,
      eventVisible: 120_000,
      eventRepeated: 120_000,
      cleanup: 30_000,
      run: 480_000,
    });
  });

  it('maps every variable', () => {
    const { config } = expectOk(loadConfig(validEnv({
      LOG_LEVEL: 'debug',
      INTERNAL_HOST: '0.0.0.0',
      INTERNAL_PORT: '9000',
      SHUTDOWN_TIMEOUT_MS: '3000',
      HEALTH_CHECK_TIMEOUT_MS: '1500',
      HAWK_COLLECTOR_URL: 'http://localhost:3000/',
      TRANSPORT_MODE: 'ws',
      REPEAT_EVERY_N_RUNS: '0',
      HTTP_TIMEOUT_MS: '1000',
      COLLECTOR_AVAILABILITY_TIMEOUT_MS: '2000',
      API_AVAILABILITY_TIMEOUT_MS: '3000',
      COLLECTOR_ACCEPT_TIMEOUT_MS: '4000',
      EVENT_VISIBLE_TIMEOUT_MS: '5000',
      EVENT_REPEATED_TIMEOUT_MS: '6000',
      CLEANUP_TIMEOUT_MS: '7000',
      LATE_DUPLICATE_WAIT_MS: '1234',
      RUN_TIMEOUT_MS: '30000',
      NOTIFICATION_TIMEOUT_MS: '3000',
      NOTIFICATION_PAIR_WAIT_MS: '1000',
      NOTIFICATION_SETUP_TIMEOUT_MS: '4000',
      RETRY_ATTEMPTS: '2',
      RETRY_DELAYS_MS: '300',
    })));

    expect(config).toEqual({
      instanceId: 'test',
      logLevel: 'debug',
      internal: { host: '0.0.0.0',
        port: 9000 },
      shutdownTimeoutMs: 3000,
      healthCheckTimeoutMs: 1500,
      hawk: {
        apiUrl: 'http://localhost:4000/graphql',
        collectorUrl: 'http://localhost:3000/',
        integrationToken: TEST_INTEGRATION_TOKEN,
        projectId: TEST_PROJECT_ID,
        email: 'monitor@example.com',
        password: 'test-password',
      },
      transportMode: 'ws',
      repeatEveryNRuns: 0,
      httpTimeoutMs: 1000,
      retry: { attempts: 2,
        delaysMs: [300] },
      lateDuplicateWaitMs: 1234,
      timeouts: {
        collectorAvailability: 2000,
        apiAvailability: 3000,
        collectorAccept: 4000,
        eventVisible: 5000,
        eventRepeated: 6000,
        cleanup: 7000,
        run: 30_000,
      },
      notifications: {
        receiverHost: '127.0.0.1',
        receiverPort: 8091,
        receiverSecret: TEST_RECEIVER_SECRET,
        loop: true,
        timeoutMs: 3000,
        pairWaitMs: 1000,
        setupTimeoutMs: 4000,
        ruleCacheWarmupMs: 65_000,
      },
      monitoring: {
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
      },
    });
  });

  it('names missing required variables', () => {
    const errors = expectErrors(loadConfig({}));

    expect(errors.map(error => error.variable).sort()).toEqual([
      'HAWK_API_URL',
      'HAWK_EMAIL',
      'HAWK_INTEGRATION_TOKEN',
      'HAWK_PASSWORD',
      'HAWK_PROJECT_ID',
      'INSTANCE_ID',
    ]);
    expect(errors.every(error => error.message === 'is required')).toBe(true);
  });

  it('treats empty string as missing', () => {
    const { config } = expectOk(loadConfig(validEnv({ HAWK_API_URL: 'https://api.hawk.so/graphql',
      HAWK_COLLECTOR_URL: '' })));

    expect(config.hawk.collectorUrl).toBeUndefined();
  });

  it('empty required is missing', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_PASSWORD: '' })));

    expect(errors).toEqual([{ variable: 'HAWK_PASSWORD',
      message: 'is required' }]);
  });

  it.each(['not-a-url', 'localhost:4000/graphql', 'ftp://x'])('rejects non-http URLs: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_API_URL: value })));

    expect(errors.map(error => error.variable)).toEqual(['HAWK_API_URL']);
  });

  it.each(['0', '65536', 'abc'])('rejects bad port: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ INTERNAL_PORT: value })));

    expect(errors).toEqual([{ variable: 'INTERNAL_PORT',
      message: 'must be a port number from 1 to 65535' }]);
  });

  it.each(['Prod', 'a b', 'a'.repeat(33)])('rejects bad instance id: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ INSTANCE_ID: value })));

    expect(errors.map(error => error.variable)).toEqual(['INSTANCE_ID']);
  });

  it('reports all errors at once', () => {
    const errors = expectErrors(loadConfig({ INSTANCE_ID: 'BAD',
      INTERNAL_PORT: '0' }));

    expect(errors).toHaveLength(7);
    expect(errors).toContainEqual({ variable: 'INSTANCE_ID',
      message: 'must be 1-32 characters: a-z, 0-9, -' });
    expect(errors).toContainEqual({ variable: 'INTERNAL_PORT',
      message: 'must be a port number from 1 to 65535' });

    const required = errors.filter(error => error.message === 'is required').map(error => error.variable);

    expect(required.sort()).toEqual([
      'HAWK_API_URL',
      'HAWK_EMAIL',
      'HAWK_INTEGRATION_TOKEN',
      'HAWK_PASSWORD',
      'HAWK_PROJECT_ID',
    ]);
  });

  it.each(['', 'abc', 'G'.repeat(24), 'ABCDEF0123456789ABCDEF01', '0123456789abcdef0123456'])('rejects bad project id: "%s"', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_PROJECT_ID: value })));

    expect(errors.map(error => error.variable)).toEqual(['HAWK_PROJECT_ID']);
    expect(errors[0]?.message).toBe(value === '' ? 'is required' : 'must be a 24-character hex id');
  });

  it.each(['not-base64!', Buffer.from('not json').toString('base64'), Buffer.from('{"integrationId":"","secret":"x"}').toString('base64')])('rejects an integration token that does not decode: %s', (value) => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_INTEGRATION_TOKEN: value })));

    expect(errors).toEqual([{ variable: 'HAWK_INTEGRATION_TOKEN',
      message: 'must be a Hawk integration token (base64 JSON with integrationId and secret)' }]);
  });

  it('accepts 12 digits in the instance id and rejects 13', () => {
    expectOk(loadConfig(validEnv({ INSTANCE_ID: 'a1-2-3-4-5-6-7-8-9-0-1-2' })));

    const errors = expectErrors(loadConfig(validEnv({ INSTANCE_ID: 'a1-2-3-4-5-6-7-8-9-0-1-2-3' })));

    expect(errors).toEqual([{ variable: 'INSTANCE_ID',
      message: 'must contain at most 12 digits' }]);
  });

  it.each(['alternate', 'http', 'ws'])('accepts TRANSPORT_MODE %s', (value) => {
    expect(expectOk(loadConfig(validEnv({ TRANSPORT_MODE: value }))).config.transportMode).toBe(value);
  });

  it('rejects an unknown TRANSPORT_MODE', () => {
    const errors = expectErrors(loadConfig(validEnv({ TRANSPORT_MODE: 'udp' })));

    expect(errors.map(error => error.variable)).toEqual(['TRANSPORT_MODE']);
  });

  it.each(['-1', '1.5', 'abc'])('rejects bad REPEAT_EVERY_N_RUNS: %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ REPEAT_EVERY_N_RUNS: value })))).toEqual([{ variable: 'REPEAT_EVERY_N_RUNS',
      message: 'must be a whole number, 0 or more' }]);
  });

  it('HTTP_TIMEOUT_MS must be less than every stage timeout', () => {
    const errors = expectErrors(loadConfig(validEnv({ HTTP_TIMEOUT_MS: '10000',
      CLEANUP_TIMEOUT_MS: '10000' }))).filter(error => error.variable === 'HTTP_TIMEOUT_MS');

    expect(errors).toEqual([
      { variable: 'HTTP_TIMEOUT_MS',
        message: 'must be less than COLLECTOR_ACCEPT_TIMEOUT_MS' },
      { variable: 'HTTP_TIMEOUT_MS',
        message: 'must be less than CLEANUP_TIMEOUT_MS' },
    ]);
  });

  it('LATE_DUPLICATE_WAIT_MS may be 0, which turns the pause off', () => {
    expect(expectOk(loadConfig(validEnv({ LATE_DUPLICATE_WAIT_MS: '0' }))).config.lateDuplicateWaitMs).toBe(0);
  });

  it.each(['-1', '1.5', 'abc'])('rejects bad LATE_DUPLICATE_WAIT_MS: %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ LATE_DUPLICATE_WAIT_MS: value }))).map(error => error.variable)).toEqual(['LATE_DUPLICATE_WAIT_MS']);
  });

  it('LATE_DUPLICATE_WAIT_MS must leave room for the recheck and removal', () => {
    expectOk(loadConfig(validEnv({ LATE_DUPLICATE_WAIT_MS: '10000' })));

    expect(expectErrors(loadConfig(validEnv({ LATE_DUPLICATE_WAIT_MS: '10001' })))).toEqual([{ variable: 'LATE_DUPLICATE_WAIT_MS',
      message: 'must leave room for the recheck and removal: LATE_DUPLICATE_WAIT_MS + 4 * HTTP_TIMEOUT_MS must not exceed CLEANUP_TIMEOUT_MS (30001 ms)' }]);
  });

  it('the default timeouts are valid together', () => {
    expectOk(loadConfig(validEnv()));
  });

  it('RUN_TIMEOUT_MS must cover stages 1-5, cleanup not counted', () => {
    // The check-notification sum is the larger one, so 315000 satisfies both.
    expectOk(loadConfig(validEnv({ RUN_TIMEOUT_MS: '315000',
      CLEANUP_TIMEOUT_MS: '99999999',
      CHECK_INTERVAL_MS: '200000000',
      SWEEP_MIN_AGE_MS: '200000000' })));

    expect(expectErrors(loadConfig(validEnv({ RUN_TIMEOUT_MS: '279999' })))).toContainEqual({ variable: 'RUN_TIMEOUT_MS',
      message: 'must be at least the sum of the timeouts of stages 1-5 (280000 ms)' });
  });

  it('mixed hosts are an error', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_COLLECTOR_URL: undefined })));

    expect(errors).toEqual([{ variable: 'HAWK_COLLECTOR_URL',
      message: 'must be set when HAWK_API_URL is not a hawk.so host' }]);
  });

  it.each(['https://hawk.so/graphql', 'https://api.hawk.so/graphql'])('collector URL may be empty for %s', (url) => {
    expect(expectOk(loadConfig(validEnv({ HAWK_API_URL: url,
      HAWK_COLLECTOR_URL: undefined }))).config.hawk.collectorUrl).toBeUndefined();
  });

  it('look-alike domain is not production', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_API_URL: 'https://api.nothawk.so/graphql',
      HAWK_COLLECTOR_URL: undefined })));

    expect(errors.map(error => error.variable)).toEqual(['HAWK_COLLECTOR_URL']);
  });

  it('never echoes secret values', () => {
    const errors = expectErrors(loadConfig(validEnv({ HAWK_INTEGRATION_TOKEN: 'bad token s3cr3t-probe' })));

    // Both the whitespace rule and the decode rule report it.
    expect(errors.map(error => error.variable)).toEqual(['HAWK_INTEGRATION_TOKEN', 'HAWK_INTEGRATION_TOKEN']);
    expect(JSON.stringify(errors)).not.toContain('s3cr3t-probe');
    expect(formatConfigErrors(errors)).not.toContain('s3cr3t-probe');
  });
});

describe('formatConfigErrors', () => {
  it('formats errors for humans', () => {
    const text = formatConfigErrors([
      { variable: 'INSTANCE_ID',
        message: 'must be 1-32 characters: a-z, 0-9, -' },
      { variable: 'HAWK_PASSWORD',
        message: 'is required' },
    ]);

    expect(text.startsWith('Invalid configuration:\n')).toBe(true);
    expect(text).toContain('  INSTANCE_ID: must be 1-32 characters: a-z, 0-9, -\n');
    expect(text).toContain('  HAWK_PASSWORD: is required\n');
    expect(text.endsWith('See .env.example for all variables.\n')).toBe(true);
  });
});
