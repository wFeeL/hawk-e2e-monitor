import { describe, expect, it } from 'vitest';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';
import { loadConfig } from '../../src/config/load.js';

const BOT_TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz0123456789';
const NOTIFY_URL = 'https://notify.bot.codex.so/u/testgroup1';

/**
 * Loads the env for `serve` and returns every error as one printed line.
 * @param overrides Variables to set.
 * @returns Lines `NAME: text`.
 */
function serveLines(overrides: Record<string, string | undefined>): string[] {
  return expectErrors(loadConfig(validEnv(overrides), { command: 'serve' })).map(error => `${error.variable}: ${error.message}`);
}

describe('requirements of serve', () => {
  it('lists the notification requirements together with the missing Hawk variables', () => {
    expect(serveLines({ SCENARIOS: 'check-notification',
      RECEIVER_SECRET: undefined,
      HAWK_PASSWORD: undefined })).toEqual([
      'HAWK_PASSWORD: is required',
      'RECEIVER_SECRET: is required for check-notification',
      'PUBLIC_BASE_URL: set PUBLIC_BASE_URL or TUNNEL_METRICS_URL for check-notification',
    ]);
  });

  it('names telegram-delivery when it is the scenario that needs the receiver and the bot', () => {
    expect(serveLines({ SCENARIOS: 'telegram-delivery',
      RECEIVER_SECRET: undefined,
      PUBLIC_BASE_URL: 'https://monitor.example.test' })).toEqual([
      'RECEIVER_SECRET: is required for telegram-delivery',
      'TELEGRAM_BOT_TOKEN: is required for telegram-delivery',
      'TELEGRAM_NOTIFY_URL: is required for telegram-delivery',
    ]);
  });

  it('rejects a malformed token and notify address without printing them', () => {
    const lines = serveLines({ SCENARIOS: 'telegram-delivery',
      PUBLIC_BASE_URL: 'https://monitor.example.test',
      TELEGRAM_BOT_TOKEN: 'short',
      TELEGRAM_NOTIFY_URL: 'https://example.test/x' });

    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('short');
  });

  it('accepts a complete setup', () => {
    expectOk(loadConfig(validEnv({ SCENARIOS: 'check-notification,telegram-delivery',
      PUBLIC_BASE_URL: 'https://monitor.example.test',
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_NOTIFY_URL: NOTIFY_URL }), { command: 'serve' }));
  });

  it('asks nothing extra of scenarios that need no receiver', () => {
    expectOk(loadConfig(validEnv({ RECEIVER_SECRET: undefined }), { command: 'serve' }));
  });

  it('leaves the other commands to their own checks', () => {
    const env = validEnv({ SCENARIOS: 'check-notification',
      RECEIVER_SECRET: undefined });

    expectOk(loadConfig(env));
    expectOk(loadConfig(env, { command: 'check' }));
  });
});
