import { describe, expect, it } from 'vitest';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { describeConfig } from '../../src/config/describe.js';
import { loadConfig } from '../../src/config/load.js';

const DELAYS_MESSAGE = 'must be comma-separated whole milliseconds from 0 to 60000';

describe('retry configuration', () => {
  it('defaults to 3 attempts with pauses of 200 and 500 ms', () => {
    expect(expectOk(loadConfig(validEnv())).config.retry).toEqual({ attempts: 3,
      delaysMs: [200, 500] });
  });

  it('reads attempts and pauses', () => {
    const { retry } = expectOk(loadConfig(validEnv({ RETRY_ATTEMPTS: '4',
      RETRY_DELAYS_MS: '100, 200,300' }))).config;

    expect(retry).toEqual({ attempts: 4,
      delaysMs: [100, 200, 300] });
  });

  it('one attempt ignores the pauses', () => {
    expect(expectOk(loadConfig(validEnv({ RETRY_ATTEMPTS: '1' }))).config.retry.attempts).toBe(1);
    expectOk(loadConfig(validEnv({ RETRY_ATTEMPTS: '1',
      RETRY_DELAYS_MS: '60000,60000' })));
  });

  it.each(['0', '6', '2.5', 'abc'])('rejects RETRY_ATTEMPTS %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ RETRY_ATTEMPTS: value })))).toContainEqual({ variable: 'RETRY_ATTEMPTS',
      message: 'must be a whole number from 1 to 5' });
  });

  it.each(['abc', '200,,500', '-5,10', '1.5,2', '200,60001'])('rejects RETRY_DELAYS_MS %s', (value) => {
    expect(expectErrors(loadConfig(validEnv({ RETRY_DELAYS_MS: value })))).toContainEqual({ variable: 'RETRY_DELAYS_MS',
      message: DELAYS_MESSAGE });
  });

  it('needs one pause fewer than the attempts', () => {
    expect(expectErrors(loadConfig(validEnv({ RETRY_ATTEMPTS: '4' })))).toEqual([{ variable: 'RETRY_DELAYS_MS',
      message: 'must list one pause fewer than RETRY_ATTEMPTS: 4 attempts need a list of 3, got 2' }]);
    expect(expectErrors(loadConfig(validEnv({ RETRY_ATTEMPTS: '2' })))).toEqual([{ variable: 'RETRY_DELAYS_MS',
      message: 'must list one pause fewer than RETRY_ATTEMPTS: 2 attempts need a list of 1, got 2' }]);
  });

  it('the pauses must fit the shortest stage timeout', () => {
    expectOk(loadConfig(validEnv({ RETRY_DELAYS_MS: '5000,5000' })));

    expect(expectErrors(loadConfig(validEnv({ RETRY_DELAYS_MS: '5000,5001' })))).toEqual([{ variable: 'RETRY_DELAYS_MS',
      message: 'pauses add up to 10001 ms, more than COLLECTOR_ACCEPT_TIMEOUT_MS (10000 ms), the shortest timeout that contains retries; shorten RETRY_DELAYS_MS or lower RETRY_ATTEMPTS' }]);
  });

  it('the notification setup timeout counts as a stage timeout', () => {
    const errors = expectErrors(loadConfig(validEnv({ NOTIFICATION_SETUP_TIMEOUT_MS: '9000',
      RETRY_DELAYS_MS: '5000,5000' })));

    expect(errors.filter(error => error.variable === 'RETRY_DELAYS_MS').map(error => error.message)).toEqual([
      expect.stringContaining('more than NOTIFICATION_SETUP_TIMEOUT_MS (9000 ms)'),
    ]);
  });

  it('shows both variables in the startup summary', () => {
    const { values } = describeConfig(expectOk(loadConfig(validEnv())).env);

    expect(values).toMatchObject({ RETRY_ATTEMPTS: '3',
      RETRY_DELAYS_MS: '[200,500]' });
  });
});
