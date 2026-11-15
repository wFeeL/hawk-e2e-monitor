import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { createMasking } from '../../src/serve/masking.js';
import { validEnv } from '../support/env.js';
import { expectOk } from '../support/result.js';

const TOKEN = 'run-token-0123456789-0123456789-ab';

describe('createMasking', () => {
  it('masks the heartbeat address, its path and the run token', () => {
    const config = expectOk(loadConfig(validEnv({ HEARTBEAT_URL: 'https://hc-ping.example.test/pings/3f1c2a9e-0000',
      RUN_TOKEN: TOKEN }))).config;
    const { redact } = createMasking(config);

    expect(redact('GET https://hc-ping.example.test/pings/3f1c2a9e-0000 failed')).toBe('GET *** failed');
    expect(redact('path /pings/3f1c2a9e-0000 and the token')).toBe('path *** and the token');
    expect(redact(`Bearer ${TOKEN}`)).toBe('Bearer ***');
  });

  it('still masks the credentials of the scenarios and the alert address', () => {
    const config = expectOk(loadConfig(validEnv({ ALERT_NOTIFY_URL: 'https://notify.example.test/u/chat-token-123' }))).config;
    const { redact } = createMasking(config);

    expect(redact('test-password chat-token-123')).toBe('*** ***');
  });

  it('adds nothing when there is no heartbeat address and no token', () => {
    const { redact } = createMasking(expectOk(loadConfig(validEnv())).config);

    expect(redact('https://hc-ping.example.test/ and /')).toBe('https://hc-ping.example.test/ and /');
  });
});
