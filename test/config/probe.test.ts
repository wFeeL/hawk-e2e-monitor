import { describe, expect, it } from 'vitest';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { describeConfig } from '../../src/config/describe.js';
import { loadConfig } from '../../src/config/load.js';

const PROBE_SCENARIOS = 'send-and-receive-event,endpoints-probe';

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

describe('probe configuration', () => {
  it('has the defaults of the spec and no Garage address', () => {
    const { config } = expectOk(loadConfig(validEnv()));

    expect(config.monitoring.probe).toEqual({ intervalMs: 90_000,
      alertAfterFailures: 3,
      retentionDays: 7 });
    expect(config.hawk.garageUrl).toBeUndefined();
    expect(config.timeouts.garage).toBe(15_000);
  });

  it('accepts endpoints-probe among the scenarios', () => {
    const { monitoring } = expectOk(loadConfig(validEnv({ SCENARIOS: 'send-and-receive-event,endpoints-probe' }))).config;

    expect(monitoring.scenarios).toEqual(['send-and-receive-event', 'endpoints-probe']);
  });

  it('reads every variable and keeps only the origin of the Garage address', () => {
    const { config } = expectOk(loadConfig(validEnv({ PROBE_INTERVAL_MS: '120000',
      PROBE_ALERT_AFTER_FAILURES: '10',
      PROBE_RETENTION_DAYS: '30',
      GARAGE_URL: 'http://garage.example.test:8080/',
      GARAGE_TIMEOUT_MS: '20000' })));

    expect(config.monitoring.probe).toEqual({ intervalMs: 120_000,
      alertAfterFailures: 10,
      retentionDays: 30 });
    expect(config.hawk.garageUrl).toBe('http://garage.example.test:8080');
    expect(config.timeouts.garage).toBe(20_000);
  });

  it('rejects values outside the ranges, naming the variable', () => {
    expect(messagesOf({ PROBE_INTERVAL_MS: '9999' }, 'PROBE_INTERVAL_MS')[0]).toContain('from 10000');
    expect(messagesOf({ PROBE_ALERT_AFTER_FAILURES: '0' }, 'PROBE_ALERT_AFTER_FAILURES')).toHaveLength(1);
    expect(messagesOf({ PROBE_ALERT_AFTER_FAILURES: '11' }, 'PROBE_ALERT_AFTER_FAILURES')).toHaveLength(1);
    expect(messagesOf({ PROBE_RETENTION_DAYS: '0' }, 'PROBE_RETENTION_DAYS')).toHaveLength(1);
  });

  it('keeps the probe interval within CHECK_INTERVAL_MS', () => {
    expect(messagesOf({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '600001' }, 'PROBE_INTERVAL_MS')[0]).toContain('CHECK_INTERVAL_MS');
    expectOk(loadConfig(validEnv({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '600000' })));
  });

  it('keeps the probe retention within HISTORY_RETENTION_DAYS', () => {
    expect(messagesOf({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_RETENTION_DAYS: '31' }, 'PROBE_RETENTION_DAYS')[0]).toContain('HISTORY_RETENTION_DAYS');
    expectOk(loadConfig(validEnv({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_RETENTION_DAYS: '30' })));
  });

  it('makes the probe interval greater than its stage timeouts plus 10 s', () => {
    // 15000 + 15000 without Garage.
    expect(messagesOf({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '40000' }, 'PROBE_INTERVAL_MS')[0]).toContain('30000 ms');
    expect(messagesOf({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '40000' }, 'PROBE_INTERVAL_MS')[0]).toContain('+ 10000');
    expectOk(loadConfig(validEnv({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '40001' })));
  });

  it('counts the Garage timeout in that sum only when there is a Garage address', () => {
    expectOk(loadConfig(validEnv({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '40001',
      GARAGE_TIMEOUT_MS: '60000' })));
    expect(messagesOf({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '55000',
      GARAGE_URL: 'http://garage.example.test' }, 'PROBE_INTERVAL_MS')).toHaveLength(1);
    expectOk(loadConfig(validEnv({ SCENARIOS: PROBE_SCENARIOS,
      PROBE_INTERVAL_MS: '55001',
      GARAGE_URL: 'http://garage.example.test' })));
  });

  it('wants GARAGE_TIMEOUT_MS greater than HTTP_TIMEOUT_MS when there is a Garage address', () => {
    const garage = { GARAGE_URL: 'http://garage.example.test' };

    expect(messagesOf({ ...garage,
      GARAGE_TIMEOUT_MS: '5000' }, 'GARAGE_TIMEOUT_MS')[0]).toContain('HTTP_TIMEOUT_MS');
    expectOk(loadConfig(validEnv({ ...garage,
      GARAGE_TIMEOUT_MS: '5001' })));
  });

  it('checks the retry pauses against GARAGE_TIMEOUT_MS when there is a Garage address', () => {
    const retry = { RETRY_ATTEMPTS: '3',
      RETRY_DELAYS_MS: '4000,4000',
      GARAGE_TIMEOUT_MS: '6000',
      HTTP_TIMEOUT_MS: '1000' };

    expectOk(loadConfig(validEnv(retry)));
    expect(messagesOf({ ...retry,
      GARAGE_URL: 'http://garage.example.test' }, 'RETRY_DELAYS_MS')[0]).toContain('GARAGE_TIMEOUT_MS');
  });

  it('wants an http(s) origin for GARAGE_URL: no path, query or credentials, no blocked port', () => {
    expect(messagesOf({ GARAGE_URL: 'ftp://garage.example.test' }, 'GARAGE_URL')).toHaveLength(1);
    expect(messagesOf({ GARAGE_URL: 'http://garage.example.test/app/' }, 'GARAGE_URL')[0]).toContain('origin');
    expect(messagesOf({ GARAGE_URL: 'http://garage.example.test/?x=1' }, 'GARAGE_URL')[0]).toContain('origin');
    expect(messagesOf({ GARAGE_URL: 'http://user:pass@garage.example.test' }, 'GARAGE_URL')[0]).toContain('origin');
    expect(messagesOf({ GARAGE_URL: 'http://garage.example.test:6000' }, 'GARAGE_URL')[0]).toContain('port 6000');
  });

  it('shows the probe variables and the Garage address in the summary', () => {
    const summary = describeConfig(expectOk(loadConfig(validEnv({ GARAGE_URL: 'http://garage.example.test:8080' }))).env);

    expect(summary.values.GARAGE_URL).toBe('http://garage.example.test:8080');
    expect(summary.values.PROBE_INTERVAL_MS).toBe('90000');
    expect(summary.values.GARAGE_TIMEOUT_MS).toBe('15000');
  });

  describe('without the probe', () => {
    it('accepts what was valid before the probe existed: a long HTTP timeout and raised stage timeouts', () => {
      const env = { HTTP_TIMEOUT_MS: '20000',
        COLLECTOR_AVAILABILITY_TIMEOUT_MS: '60000',
        API_AVAILABILITY_TIMEOUT_MS: '60000',
        COLLECTOR_ACCEPT_TIMEOUT_MS: '60000',
        EVENT_VISIBLE_TIMEOUT_MS: '60000',
        EVENT_REPEATED_TIMEOUT_MS: '60000',
        CLEANUP_TIMEOUT_MS: '90000',
        // The check-notification stages add up to 565000 ms, the wait for the threshold notification included.
        RUN_TIMEOUT_MS: '565000',
        CHECK_INTERVAL_MS: '700000' };

      expectOk(loadConfig(validEnv(env)));
      expectOk(loadConfig(validEnv({ ...env,
        SCENARIOS: 'send-and-receive-event' })));
    });

    it('accepts a short history retention and ignores the probe retention', () => {
      expectOk(loadConfig(validEnv({ HISTORY_RETENTION_DAYS: '3' })));
    });

    it('does not compare GARAGE_TIMEOUT_MS with HTTP_TIMEOUT_MS without GARAGE_URL', () => {
      expectOk(loadConfig(validEnv({ HTTP_TIMEOUT_MS: '9000',
        CLEANUP_TIMEOUT_MS: '60000',
        GARAGE_TIMEOUT_MS: '5000' })));
    });
  });

  describe('with the probe selected', () => {
    const PROBE = { SCENARIOS: 'send-and-receive-event,endpoints-probe' };

    it('rejects the same configurations the rules are for', () => {
      expect(messagesOf({ ...PROBE,
        HISTORY_RETENTION_DAYS: '3' }, 'PROBE_RETENTION_DAYS')[0]).toContain('HISTORY_RETENTION_DAYS');
      expect(messagesOf({ ...PROBE,
        COLLECTOR_AVAILABILITY_TIMEOUT_MS: '60000',
        API_AVAILABILITY_TIMEOUT_MS: '60000' }, 'PROBE_INTERVAL_MS')).toHaveLength(1);
    });

    it('wants GARAGE_TIMEOUT_MS above HTTP_TIMEOUT_MS only with GARAGE_URL', () => {
      expectOk(loadConfig(validEnv({ ...PROBE,
        HTTP_TIMEOUT_MS: '9000',
        CLEANUP_TIMEOUT_MS: '60000',
        GARAGE_TIMEOUT_MS: '5000' })));
      expect(messagesOf({ ...PROBE,
        GARAGE_URL: 'http://garage.example.test',
        HTTP_TIMEOUT_MS: '9000',
        CLEANUP_TIMEOUT_MS: '60000',
        GARAGE_TIMEOUT_MS: '5000',
        PROBE_INTERVAL_MS: '90000' }, 'GARAGE_TIMEOUT_MS')[0]).toContain('HTTP_TIMEOUT_MS');
    });
  });
});
