import { describe, expect, it } from 'vitest';
import { ConfigFailure, loadConfig, telegramSettings } from '../../src/config/load.js';
import type { Config } from '../../src/config/load.js';
import { scenarioSettings } from '../../src/config/scenario.js';
import { scenarioSecrets } from '../../src/scenarios/shared/deps.js';
import { testConfig } from '../support/config.js';
import { validEnv } from '../support/env.js';
import { expectErrors, expectOk } from '../support/result.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXGnBiXrW0Q4Yp7yP1Z';
const URL_TOKEN = 'abc123XYZ';
const NOTIFY_URL = `https://notify.bot.codex.so/u/${URL_TOKEN}`;
const TELEGRAM_ENV = { SCENARIOS: 'telegram-delivery',
  PUBLIC_BASE_URL: 'https://hooks.example.com',
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_NOTIFY_URL: NOTIFY_URL };

/**
 * Loads a valid config with overrides.
 * @param overrides Variables to replace.
 * @returns Config.
 */
function load(overrides: Record<string, string | undefined> = {}): Config {
  return expectOk(loadConfig(validEnv(overrides))).config;
}

/**
 * Lists the messages of the errors on one variable.
 * @param overrides Variables to replace.
 * @param variable Name of the variable whose errors are returned.
 * @returns Texts of those errors, in the order loadConfig reports them.
 */
function messagesOf(overrides: Record<string, string | undefined>, variable: string): string[] {
  return expectErrors(loadConfig(validEnv(overrides))).filter(error => error.variable === variable)
    .map(error => error.message);
}

/**
 * Collects the errors `telegramSettings` throws.
 * @param config Configuration to check.
 * @returns The listed errors.
 */
function settingsErrors(config: Config): ConfigFailure['errors'] {
  try {
    telegramSettings(config);
  } catch (error) {
    if (error instanceof ConfigFailure) {
      return error.errors;
    }

    throw error;
  }

  throw new Error('Expected telegramSettings to throw');
}

describe('telegram-delivery variables', () => {
  it('uses the defaults', () => {
    expect(load().scenarios.telegramDelivery).toEqual({
      intervalMs: 3_600_000,
      senderUsername: 'codex_bot',
      apiUrl: 'https://api.telegram.org',
      deliveryTimeoutMs: 120_000,
      probeTimeoutMs: 30_000,
    });
  });

  it('maps every variable', () => {
    expect(load({ ...TELEGRAM_ENV,
      TELEGRAM_DELIVERY_INTERVAL_MS: '5000000',
      TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_SENDER_USERNAME: 'other_bot',
      TELEGRAM_API_URL: 'http://127.0.0.1:8081',
      TELEGRAM_DELIVERY_TIMEOUT_MS: '60000',
      TELEGRAM_PROBE_TIMEOUT_MS: '20000' }).scenarios.telegramDelivery).toEqual({
      intervalMs: 5_000_000,
      botToken: TOKEN,
      notifyUrl: NOTIFY_URL,
      chatId: '-1001234567890',
      senderUsername: 'other_bot',
      apiUrl: 'http://127.0.0.1:8081',
      deliveryTimeoutMs: 60_000,
      probeTimeoutMs: 20_000,
    });
  });

  it('rejects zero and text in the numbers and a chat id that is not a whole number', () => {
    for (const name of ['TELEGRAM_DELIVERY_INTERVAL_MS', 'TELEGRAM_DELIVERY_TIMEOUT_MS', 'TELEGRAM_PROBE_TIMEOUT_MS']) {
      expect(messagesOf({ [name]: '0' }, name)).toHaveLength(1);
      expect(messagesOf({ [name]: 'soon' }, name)).toHaveLength(1);
    }

    expect(messagesOf({ TELEGRAM_CHAT_ID: 'my-group' }, 'TELEGRAM_CHAT_ID')).toHaveLength(1);
    expect(load({ TELEGRAM_CHAT_ID: '-42' }).scenarios.telegramDelivery.chatId).toBe('-42');
  });

  it('is not selected by default', () => {
    expect(load().monitoring.scenarios).not.toContain('telegram-delivery');
  });
});

describe('telegramSettings', () => {
  it('returns the settings with the token and the URL present', () => {
    expect(telegramSettings(load(TELEGRAM_ENV))).toMatchObject({ botToken: TOKEN,
      notifyUrl: NOTIFY_URL });
  });

  it('names a missing token and a missing URL', () => {
    const errors = settingsErrors(load({ SCENARIOS: 'telegram-delivery' }));

    expect(errors.map(error => error.variable)).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_NOTIFY_URL']);
  });

  it('names a malformed token and URL without printing their values', () => {
    const errors = settingsErrors(load({ ...TELEGRAM_ENV,
      TELEGRAM_BOT_TOKEN: 'not-a-token-secret-value',
      TELEGRAM_NOTIFY_URL: 'https://example.com/u/leaked-path' }));

    expect(errors.map(error => error.variable)).toEqual(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_NOTIFY_URL']);

    const text = JSON.stringify(errors);

    expect(text).not.toContain('not-a-token-secret-value');
    expect(text).not.toContain('leaked-path');
  });

  it('is not part of the load: a malformed token is no error while the scenario is not selected', () => {
    expect(load({ TELEGRAM_BOT_TOKEN: 'junk',
      TELEGRAM_NOTIFY_URL: 'junk' }).scenarios.telegramDelivery.botToken).toBe('junk');
  });
});

describe('telegram-delivery watchdog', () => {
  it('sums the stage limits, the probe and the tail', () => {
    // Defaults: 15000 + 15000 * 2 + 30000 + 10000, then the longest of 120000, 125000 and 130000,
    // then 5000 + 30000 + 2 * 5000, then 30000 cleanup and 30000 grace.
    expect(scenarioSettings(load(), 'telegram-delivery')).toEqual({
      intervalMs: 3_600_000,
      watchdogMs: 320_000,
      cleanupMs: 30_000,
      alertAfterFailures: 1,
      retentionDays: 30,
    });
  });

  it('follows the delivery and probe limits from the test config', () => {
    const base = testConfig();
    const config = { ...base,
      scenarios: { ...base.scenarios,
        telegramDelivery: { ...base.scenarios.telegramDelivery,
          deliveryTimeoutMs: 1000,
          probeTimeoutMs: 400 } } };

    // 300 + 300 * 2 + 600 + 300, then max(300, 500 + 100, 1000 + 200), then 100 + 400 + 200, then 600 and 30000.
    expect(scenarioSettings(config, 'telegram-delivery').watchdogMs).toBe(300 + 600 + 600 + 300 + 1200 + 700 + 600 + 30_000);
  });

  it('the interval of the chosen scenario must exceed its watchdog', () => {
    expect(messagesOf({ SCENARIOS: 'telegram-delivery',
      PUBLIC_BASE_URL: 'https://hooks.example.com',
      TELEGRAM_DELIVERY_INTERVAL_MS: '320000' }, 'TELEGRAM_DELIVERY_INTERVAL_MS')[0]).toContain('320000 ms');
    load({ SCENARIOS: 'telegram-delivery',
      PUBLIC_BASE_URL: 'https://hooks.example.com',
      TELEGRAM_DELIVERY_INTERVAL_MS: '320001' });
    // Not chosen, so not judged.
    load({ TELEGRAM_DELIVERY_INTERVAL_MS: '1000' });
  });
});

describe('telegram secrets', () => {
  it('lists the token, the URL and the path token of the URL when they are set', () => {
    const secrets = scenarioSecrets(load(TELEGRAM_ENV));

    expect(secrets).toEqual(expect.arrayContaining([TOKEN, NOTIFY_URL, URL_TOKEN]));
  });

  it('adds nothing when they are not set', () => {
    const secrets = scenarioSecrets(load());

    expect(secrets.filter(value => value.includes('notify.bot'))).toEqual([]);
    expect(secrets).toHaveLength(scenarioSecrets(load(TELEGRAM_ENV)).length - 3);
  });
});
