import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validEnv } from '../support/env.js';
import { expectOk } from '../support/result.js';
import { describeConfig, describeEnv } from '../../src/config/describe.js';
import { loadConfig } from '../../src/config/load.js';

/**
 * Loads a valid env with overrides and summarizes it.
 * @param overrides Variables to replace in the minimal valid env.
 * @returns Summary of the loaded config.
 */
function summarize(overrides: Record<string, string | undefined> = {}): ReturnType<typeof describeConfig> {
  return describeConfig(expectOk(loadConfig(validEnv(overrides))).env);
}

describe('describeConfig', () => {
  it('hides secrets', () => {
    const summary = summarize({ HAWK_PASSWORD: 's3cr3t-probe',
      HAWK_INTEGRATION_TOKEN: Buffer.from(JSON.stringify({ integrationId: 'tok-probe',
        secret: 'sec-probe' })).toString('base64') });

    expect(summary.values.HAWK_PASSWORD).toBe('***');
    expect(JSON.stringify(summary)).not.toContain('s3cr3t-probe');
    expect(JSON.stringify(summary)).not.toContain('tok-probe');
    expect(summary.values.HAWK_INTEGRATION_TOKEN).toBe('***');
  });

  it('shows public values', () => {
    const { values } = summarize();

    expect(values.INSTANCE_ID).toBe('test');
    expect(values.INTERNAL_PORT).toBe('8090');
    expect(values.TRANSPORT_MODE).toBe('alternate');
    expect(values.RUN_TIMEOUT_MS).toBe('480000');
  });

  it('marks unset values', () => {
    expect(summarize({ HAWK_API_URL: 'https://api.hawk.so/graphql',
      HAWK_COLLECTOR_URL: undefined }).values.HAWK_COLLECTOR_URL).toBe('(unset)');
  });

  it('strips userinfo from URLs', () => {
    const value = summarize({ HAWK_API_URL: 'https://user:pa55@hawk.local/graphql' }).values.HAWK_API_URL;

    expect(value).toBe('https://hawk.local/graphql');
    expect(value).not.toContain('user');
    expect(value).not.toContain('pa55');
  });

  it('warns that the threshold rule is not checked when repeats are off and check-notification runs', () => {
    expect(summarize({ REPEAT_EVERY_N_RUNS: '0',
      SCENARIOS: 'send-and-receive-event,check-notification' }).warnings).toEqual(['REPEAT_EVERY_N_RUNS is 0: the threshold rule is not checked']);
    expect(summarize({ REPEAT_EVERY_N_RUNS: '0',
      SCENARIOS: 'send-and-receive-event' }).warnings).toEqual([]);
    expect(summarize({ REPEAT_EVERY_N_RUNS: '6',
      SCENARIOS: 'check-notification' }).warnings).toEqual([]);
  });

  it('has no warnings', () => {
    expect(summarize().warnings).toEqual([]);
  });
});

describe('describeEnv', () => {
  it('hides unmarked fields by default', () => {
    expect(describeEnv({ NEW_FIELD: z.string() }, { NEW_FIELD: 'x' })).toEqual({ NEW_FIELD: '***' });
  });
});
