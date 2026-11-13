import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validEnv } from '../test-support/env.js';
import { expectOk } from '../test-support/result.js';
import { describeConfig, describeEnv } from './describe.js';
import { loadConfig } from './load.js';

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
      HAWK_INTEGRATION_TOKEN: 'tok-probe' });

    expect(summary.values.HAWK_PASSWORD).toBe('***');
    expect(JSON.stringify(summary)).not.toContain('s3cr3t-probe');
    expect(JSON.stringify(summary)).not.toContain('tok-probe');
  });

  it('shows public values', () => {
    const { values } = summarize();

    expect(values.INSTANCE_ID).toBe('test');
    expect(values.INTERNAL_PORT).toBe('8090');
  });

  it('marks unset values', () => {
    expect(summarize().values.HAWK_COLLECTOR_URL).toBe('(unset)');
  });

  it('strips userinfo from URLs', () => {
    const value = summarize({ HAWK_API_URL: 'https://user:pa55@hawk.local/graphql' }).values.HAWK_API_URL;

    expect(value).toBe('https://hawk.local/graphql');
    expect(value).not.toContain('user');
    expect(value).not.toContain('pa55');
  });

  it('warns about mixed hosts', () => {
    expect(summarize().warnings).toEqual([
      'HAWK_COLLECTOR_URL is not set: events will go to the production collector derived from the integration token (<integrationId>.k1.hawk.so)',
    ]);
  });

  it('no warning for production API', () => {
    expect(summarize({ HAWK_API_URL: 'https://api.hawk.so/graphql' }).warnings).toEqual([]);
  });

  it('look-alike domain is not production', () => {
    expect(summarize({ HAWK_API_URL: 'https://api.nothawk.so/graphql' }).warnings).toHaveLength(1);
  });

  it('no warning when collector is set', () => {
    expect(summarize({ HAWK_COLLECTOR_URL: 'http://localhost:3000/' }).warnings).toEqual([]);
  });
});

describe('describeEnv', () => {
  it('hides unmarked fields by default', () => {
    expect(describeEnv({ NEW_FIELD: z.string() }, { NEW_FIELD: 'x' })).toEqual({ NEW_FIELD: '***' });
  });
});
