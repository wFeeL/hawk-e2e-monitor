import { describe, expect, it } from 'vitest';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { describeConfig } from '../../src/config/describe.js';
import { loadConfig } from '../../src/config/load.js';

const TOKEN = 'run-token-0123456789-0123456789-ab';
const PING = 'https://hc-ping.example.test/3f1c2a9e-0000-4000-8000-123456789abc';

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

describe('heartbeat and manual run configuration', () => {
  it('has no heartbeat address and no token by default', () => {
    const { monitoring } = expectOk(loadConfig(validEnv())).config;

    expect(monitoring.heartbeat).toEqual({ intervalMs: 60_000 });
    expect(monitoring.manual).toEqual({ minIntervalMs: 60_000 });
  });

  it('treats empty values as unset', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ HEARTBEAT_URL: '',
      RUN_TOKEN: '' }))).config;

    expect(monitoring.heartbeat.url).toBeUndefined();
    expect(monitoring.manual.token).toBeUndefined();
  });

  it('reads every variable', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ HEARTBEAT_URL: PING,
      HEARTBEAT_INTERVAL_MS: '10000',
      RUN_TOKEN: TOKEN,
      MANUAL_MIN_INTERVAL_MS: '0' }))).config;

    expect(monitoring.heartbeat).toEqual({ url: PING,
      intervalMs: 10_000 });
    expect(monitoring.manual).toEqual({ token: TOKEN,
      minIntervalMs: 0 });
  });

  it('accepts the edges of the ranges', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ HEARTBEAT_INTERVAL_MS: '3600000',
      MANUAL_MIN_INTERVAL_MS: '3600000',
      RUN_TOKEN: 'x'.repeat(32) }))).config;

    expect(monitoring.heartbeat.intervalMs).toBe(3_600_000);
    expect(monitoring.manual.minIntervalMs).toBe(3_600_000);
  });

  it('rejects values outside the ranges, a short token and a bad address, naming the variable', () => {
    expect(messagesOf({ HEARTBEAT_INTERVAL_MS: '9999' }, 'HEARTBEAT_INTERVAL_MS')).toHaveLength(1);
    expect(messagesOf({ HEARTBEAT_INTERVAL_MS: '3600001' }, 'HEARTBEAT_INTERVAL_MS')).toHaveLength(1);
    expect(messagesOf({ MANUAL_MIN_INTERVAL_MS: '3600001' }, 'MANUAL_MIN_INTERVAL_MS')).toHaveLength(1);
    expect(messagesOf({ MANUAL_MIN_INTERVAL_MS: 'soon' }, 'MANUAL_MIN_INTERVAL_MS')).toHaveLength(1);
    expect(messagesOf({ RUN_TOKEN: 'x'.repeat(31) }, 'RUN_TOKEN')).toEqual(['must be at least 32 characters']);
    expect(messagesOf({ HEARTBEAT_URL: 'ftp://hc.example.test/ping' }, 'HEARTBEAT_URL')).toEqual(['must be an http(s) URL']);
    expect(messagesOf({ HEARTBEAT_URL: 'not a url' }, 'HEARTBEAT_URL')).toHaveLength(1);
  });

  it('rejects an address with a port that fetch blocks', () => {
    expect(messagesOf({ HEARTBEAT_URL: 'http://hc.example.test:6000/ping' }, 'HEARTBEAT_URL')[0]).toContain('port 6000');
  });

  it('hides the address and the token in the summary and shows the intervals', () => {
    const summary = describeConfig(expectOk(loadConfig(validEnv({ HEARTBEAT_URL: PING,
      RUN_TOKEN: TOKEN }))).env);

    expect(summary.values.HEARTBEAT_URL).toBe('***');
    expect(summary.values.RUN_TOKEN).toBe('***');
    expect(JSON.stringify(summary)).not.toContain('3f1c2a9e');
    expect(JSON.stringify(summary)).not.toContain(TOKEN);
    expect(summary.values.HEARTBEAT_INTERVAL_MS).toBe('60000');
    expect(summary.values.MANUAL_MIN_INTERVAL_MS).toBe('60000');
  });
});
