import { describe, expect, it } from 'vitest';
import { TEST_RECEIVER_SECRET, validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { ConfigFailure, loadConfig, notificationSettings } from '../../src/config/load.js';
import type { Config } from '../../src/config/load.js';

const SECRET_MESSAGE = 'must be at least 32 characters: A-Z, a-z, 0-9, _ and -';
const BASE_URL_MESSAGE = 'must be an https address without a path, on port 443';

/**
 * Loads a valid config with overrides.
 * @param overrides Variables to replace.
 * @returns Config.
 */
function load(overrides: Record<string, string | undefined> = {}): Config {
  return expectOk(loadConfig(validEnv(overrides))).config;
}

/**
 * Collects what `notificationSettings` throws.
 * @param config Loaded configuration whose notification settings are validated.
 * @returns The error that the call raised; fails the test when nothing was raised.
 */
function thrownBy(config: Config): unknown {
  try {
    notificationSettings(config);
  } catch (error) {
    return error;
  }

  throw new Error('Expected notificationSettings to throw');
}

describe('check-notification variables', () => {
  it('maps every variable', () => {
    const { notifications } = load({
      RECEIVER_HOST: '0.0.0.0',
      RECEIVER_PORT: '9100',
      PUBLIC_BASE_URL: 'https://hooks.example.com/',
      TUNNEL_METRICS_URL: 'http://cloudflared:2000',
      NOTIFY_LOOP: 'false',
      NOTIFICATION_TIMEOUT_MS: '100000',
      NOTIFICATION_PAIR_WAIT_MS: '2000',
      NOTIFICATION_SETUP_TIMEOUT_MS: '20000',
      RULE_CACHE_WARMUP_MS: '3000',
    });

    expect(notifications).toEqual({
      receiverHost: '0.0.0.0',
      receiverPort: 9100,
      receiverSecret: TEST_RECEIVER_SECRET,
      publicBaseUrl: 'https://hooks.example.com/',
      tunnelMetricsUrl: 'http://cloudflared:2000',
      loop: false,
      timeoutMs: 100_000,
      pairWaitMs: 2000,
      setupTimeoutMs: 20_000,
      ruleCacheWarmupMs: 3000,
    });
  });

  it('applies defaults and leaves optional values out', () => {
    const { notifications } = load({ RECEIVER_SECRET: undefined });

    expect(notifications).toEqual({
      receiverHost: '127.0.0.1',
      receiverPort: 8091,
      loop: true,
      timeoutMs: 120_000,
      pairWaitMs: 15_000,
      setupTimeoutMs: 30_000,
      ruleCacheWarmupMs: 65_000,
    });
  });

  it.each(['short', 'a'.repeat(31), `${'a'.repeat(31)}!`, `${'a'.repeat(31)} `])('rejects RECEIVER_SECRET "%s"', (value) => {
    expect(expectErrors(loadConfig(validEnv({ RECEIVER_SECRET: value })))).toEqual([{ variable: 'RECEIVER_SECRET',
      message: SECRET_MESSAGE }]);
  });

  it('accepts a long secret with _ and -', () => {
    expect(load({ RECEIVER_SECRET: `${'a-B_9'.repeat(7)}xyz` }).notifications.receiverSecret).toHaveLength(38);
  });

  it('never echoes RECEIVER_SECRET', () => {
    const errors = expectErrors(loadConfig(validEnv({ RECEIVER_SECRET: 'probe-s3cr3t!' })));

    expect(JSON.stringify(errors)).not.toContain('probe-s3cr3t');
  });

  it.each(['http://hooks.example.com', 'https://hooks.example.com/path', 'https://hooks.example.com:8443',
    'https://hooks.example.com/?a=1', 'https://user@hooks.example.com', 'hooks.example.com'])('rejects PUBLIC_BASE_URL %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ PUBLIC_BASE_URL: value })))).toEqual([{ variable: 'PUBLIC_BASE_URL',
      message: BASE_URL_MESSAGE }]);
  });

  it.each(['https://hooks.example.com', 'https://hooks.example.com/', 'https://hooks.example.com:443'])('accepts PUBLIC_BASE_URL %s', (value) => {
    expect(load({ PUBLIC_BASE_URL: value }).notifications.publicBaseUrl).toBe(value);
  });

  it.each(['ftp://x', 'not-a-url'])('rejects TUNNEL_METRICS_URL %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ TUNNEL_METRICS_URL: value }))).map(error => error.variable)).toEqual(['TUNNEL_METRICS_URL']);
  });

  it.each([['true', true], ['false', false]] as const)('NOTIFY_LOOP %s', (value, expected) => {
    expect(load({ NOTIFY_LOOP: value }).notifications.loop).toBe(expected);
  });

  it.each(['yes', '1', 'TRUE'])('rejects NOTIFY_LOOP %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ NOTIFY_LOOP: value })))).toEqual([{ variable: 'NOTIFY_LOOP',
      message: 'must be true or false' }]);
  });

  it.each(['0', '65536', 'abc'])('rejects RECEIVER_PORT %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ RECEIVER_PORT: value })))).toEqual([{ variable: 'RECEIVER_PORT',
      message: 'must be a port number from 1 to 65535' }]);
  });

  it.each(['NOTIFICATION_TIMEOUT_MS', 'NOTIFICATION_PAIR_WAIT_MS', 'NOTIFICATION_SETUP_TIMEOUT_MS', 'RULE_CACHE_WARMUP_MS'])('rejects a bad %s', (name) => {
    expect(expectErrors(loadConfig(validEnv({ [name]: '0' }))).map(error => error.variable)).toContain(name);
    expect(expectErrors(loadConfig(validEnv({ [name]: 'abc' }))).map(error => error.variable)).toContain(name);
  });

  it('INSTANCE_ID must not contain the name of the other scenario', () => {
    expect(expectErrors(loadConfig(validEnv({ INSTANCE_ID: 'send-and-receive-event' })))).toEqual([{ variable: 'INSTANCE_ID',
      message: 'must not contain "send-and-receive-event"' }]);
    expect(expectErrors(loadConfig(validEnv({ INSTANCE_ID: 'x-send-and-receive-event-y' }))).map(error => error.variable)).toEqual(['INSTANCE_ID']);
    expect(load({ INSTANCE_ID: 'send-and-receive' }).instanceId).toBe('send-and-receive');
  });
});

describe('check-notification combinations', () => {
  it('the default timeouts pass both timeout formulas', () => {
    // check-notification: 15000 + 15000 + 30000 + 10000 + max(120000, 125000) + 120000 = 315000; send-and-receive-event: 280000.
    expectOk(loadConfig(validEnv()));
  });

  it('RUN_TIMEOUT_MS must cover the check-notification stages', () => {
    expectOk(loadConfig(validEnv({ RUN_TIMEOUT_MS: '315000' })));
    expect(expectErrors(loadConfig(validEnv({ RUN_TIMEOUT_MS: '314999' })))).toEqual([{ variable: 'RUN_TIMEOUT_MS',
      message: 'must be at least the sum of the timeouts of the check-notification stages (315000 ms)' }]);
  });

  it('a long NOTIFICATION_TIMEOUT_MS raises the check-notification sum', () => {
    expect(expectErrors(loadConfig(validEnv({ RUN_TIMEOUT_MS: '350000',
      NOTIFICATION_TIMEOUT_MS: '200000',
      NOTIFICATION_PAIR_WAIT_MS: '1000' })))).toEqual([{ variable: 'RUN_TIMEOUT_MS',
      message: 'must be at least the sum of the timeouts of the check-notification stages (395000 ms)' }]);
  });

  it('the send-and-receive-event sum still applies', () => {
    expect(expectErrors(loadConfig(validEnv({ RUN_TIMEOUT_MS: '279999' }))).map(error => error.message))
      .toContain('must be at least the sum of the timeouts of stages 1-5 (280000 ms)');
  });

  it('NOTIFICATION_PAIR_WAIT_MS must be less than NOTIFICATION_TIMEOUT_MS', () => {
    expect(expectErrors(loadConfig(validEnv({ NOTIFICATION_TIMEOUT_MS: '5000',
      NOTIFICATION_PAIR_WAIT_MS: '5000' })))).toEqual([{ variable: 'NOTIFICATION_PAIR_WAIT_MS',
      message: 'must be less than NOTIFICATION_TIMEOUT_MS' }]);
  });

  it('HTTP_TIMEOUT_MS must be less than NOTIFICATION_SETUP_TIMEOUT_MS', () => {
    expect(expectErrors(loadConfig(validEnv({ HTTP_TIMEOUT_MS: '3000',
      NOTIFICATION_SETUP_TIMEOUT_MS: '3000' })))).toEqual([{ variable: 'HTTP_TIMEOUT_MS',
      message: 'must be less than NOTIFICATION_SETUP_TIMEOUT_MS' }]);
  });
});

describe('notificationSettings', () => {
  it('returns the settings when the secret and an address are set', () => {
    const config = load({ PUBLIC_BASE_URL: 'https://hooks.example.com' });

    expect(notificationSettings(config).receiverSecret).toBe(TEST_RECEIVER_SECRET);
  });

  it('accepts the tunnel address instead of the public one', () => {
    expect(notificationSettings(load({ TUNNEL_METRICS_URL: 'http://cloudflared:2000' })).tunnelMetricsUrl).toBe('http://cloudflared:2000');
  });

  it('throws ConfigFailure without a secret and without an address, secret first', () => {
    const error = thrownBy(load({ RECEIVER_SECRET: undefined }));

    expect(error).toBeInstanceOf(ConfigFailure);
    expect((error as ConfigFailure).errors).toEqual([
      { variable: 'RECEIVER_SECRET',
        message: 'is required for this command' },
      { variable: 'PUBLIC_BASE_URL',
        message: 'set PUBLIC_BASE_URL or TUNNEL_METRICS_URL' },
    ]);
  });

  it('names only the address when the secret is set', () => {
    expect((thrownBy(load()) as ConfigFailure).errors).toEqual([{ variable: 'PUBLIC_BASE_URL',
      message: 'set PUBLIC_BASE_URL or TUNNEL_METRICS_URL' }]);
  });
});
