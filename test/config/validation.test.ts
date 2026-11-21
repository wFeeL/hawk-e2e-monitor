import { describe, expect, it } from 'vitest';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { loadConfig } from '../../src/config/load.js';

const CREDENTIALS_MESSAGE = 'must not contain a user name or password';
const ALERT_URL = 'https://notify.bot.codex.so/u/alertchat1';
const GROUP_URL = 'https://notify.bot.codex.so/u/testgroup1';

/**
 * Loads the env and returns every error as one printed line.
 * @param overrides Variables to set.
 * @returns Lines `NAME: text`, in the order the user sees them.
 */
function linesOf(overrides: Record<string, string | undefined>): string[] {
  return expectErrors(loadConfig(validEnv(overrides))).map(error => `${error.variable}: ${error.message}`);
}

describe('urls with credentials', () => {
  it.each(['HAWK_API_URL', 'HAWK_COLLECTOR_URL', 'HEARTBEAT_URL', 'TUNNEL_METRICS_URL'])('%s rejects a user name and password with one line', (name) => {
    expect(linesOf({ [name]: 'http://user:secret@127.0.0.1:59990/graphql' })).toEqual([`${name}: ${CREDENTIALS_MESSAGE}`]);
  });

  it('GARAGE_URL with credentials fails with the same single line', () => {
    expect(linesOf({ GARAGE_URL: 'http://user:secret@garage.example.test' })).toEqual([`GARAGE_URL: ${CREDENTIALS_MESSAGE}`]);
  });

  it('never prints the password', () => {
    expect(linesOf({ HAWK_API_URL: 'http://user:secret@127.0.0.1:59990/graphql' }).join('\n')).not.toContain('secret');
  });
});

describe('alert address', () => {
  it('rejects ALERT_NOTIFY_URL equal to TELEGRAM_NOTIFY_URL', () => {
    expect(linesOf({ ALERT_NOTIFY_URL: GROUP_URL,
      TELEGRAM_NOTIFY_URL: GROUP_URL })).toEqual(['ALERT_NOTIFY_URL: must differ from TELEGRAM_NOTIFY_URL: alerts must not go to the test group']);
  });

  it('compares the normalized addresses', () => {
    expect(linesOf({ ALERT_NOTIFY_URL: GROUP_URL,
      TELEGRAM_NOTIFY_URL: 'HTTPS://NOTIFY.bot.codex.so:443/u/testgroup1' })).toHaveLength(1);
  });

  it('accepts different addresses', () => {
    expectOk(loadConfig(validEnv({ ALERT_NOTIFY_URL: ALERT_URL,
      TELEGRAM_NOTIFY_URL: GROUP_URL })));
  });
});

describe('check interval', () => {
  it('must exceed the run, two cleanups and the grace', () => {
    // 480000 + 2 * 30000 + 30000 = 570000 with the defaults: the cleanup runs again while the scenario is held.
    expect(linesOf({ CHECK_INTERVAL_MS: '570000' })).toEqual(['CHECK_INTERVAL_MS: must be greater than RUN_TIMEOUT_MS + 2 * CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS (570000 ms)']);
    expectOk(loadConfig(validEnv({ CHECK_INTERVAL_MS: '570001' })));
  });
});

describe('tidy errors', () => {
  it('prints one line about the field for CHECK_INTERVAL_MS=0 and no cross-field lines', () => {
    expect(linesOf({ CHECK_INTERVAL_MS: '0' })).toEqual(['CHECK_INTERVAL_MS: must be greater than 0']);
  });

  it('prints the same problem once for SCENARIOS=bogus,alsobogus', () => {
    expect(linesOf({ SCENARIOS: 'bogus,alsobogus' })).toHaveLength(1);
  });

  it('replaces the raw text of a number beyond the safe range', () => {
    expect(linesOf({ HTTP_TIMEOUT_MS: '99999999999999999999' })).toEqual(['HTTP_TIMEOUT_MS: must not exceed 2147483647 ms']);
    expect(linesOf({ RETRY_ATTEMPTS: '99999999999999999999' })).toEqual(['RETRY_ATTEMPTS: must be a whole number from 1 to 5']);
    expect(linesOf({ HISTORY_RETENTION_DAYS: '99999999999999999999' }).join('\n')).not.toContain('Too big');
    expect(linesOf({ INTERNAL_PORT: '99999999999999999999' }).join('\n')).not.toContain('Too big');
  });
});
