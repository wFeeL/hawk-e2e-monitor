import { describe, expect, it } from 'vitest';
import { loadHistoryConfig } from '../../src/config/load.js';

describe('loadHistoryConfig', () => {
  it('needs nothing from Hawk: an empty environment gives the defaults', () => {
    expect(loadHistoryConfig({})).toEqual({ ok: true,
      config: { databasePath: 'data/monitor.db',
        scenarios: ['send-and-receive-event', 'check-notification', 'sourcemaps', 'sentry-envelope', 'endpoints-probe'] } });
  });

  it('reads only DATABASE_PATH and SCENARIOS', () => {
    expect(loadHistoryConfig({ DATABASE_PATH: '/tmp/x.db',
      SCENARIOS: 'sourcemaps, send-and-receive-event',
      HAWK_API_URL: 'not a url' })).toEqual({ ok: true,
      config: { databasePath: '/tmp/x.db',
        scenarios: ['sourcemaps', 'send-and-receive-event'] } });
  });

  it('treats an empty value as unset', () => {
    expect(loadHistoryConfig({ DATABASE_PATH: '' })).toMatchObject({ ok: true,
      config: { databasePath: 'data/monitor.db' } });
  });

  it('names an invalid scenario list once', () => {
    expect(loadHistoryConfig({ SCENARIOS: 'bogus,alsobogus' })).toEqual({ ok: false,
      errors: [{ variable: 'SCENARIOS',
        message: expect.stringContaining('must be a comma-separated list of') as string }] });
  });
});
