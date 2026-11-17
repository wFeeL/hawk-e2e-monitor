import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisionCommand } from '../../src/cli.js';
import type { CheckIo } from '../../src/commands/check.js';
import { runProvisionCommand } from '../../src/commands/provision.js';
import type { Config } from '../../src/config/load.js';
import type { PublicAddress } from '../../src/notifications/address.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../../src/storage/keys.js';
import { tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { TEST_RECEIVER_SECRET } from '../support/env.js';
import { createFakeClock } from '../support/fake-clock.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { createTestDeps } from '../support/scenario.js';

const WAIT: ProvisionCommand = { kind: 'provision',
  wait: true };
const NO_WAIT: ProvisionCommand = { kind: 'provision',
  wait: false };
const HOST = 'abc.trycloudflare.com';
const NOTIFY_URL = 'https://notify.bot.codex.so/u/abc123';
const TOKEN = '123456789:AAEhBOweik6ad9r_QXGnBiXrW0Q4Yp7yP1Z';
const ADDRESS: PublicAddress = { baseUrl: `https://${HOST}`,
  hostname: HOST,
  source: 'config' };

let hawk: FakeHawk;
let database: TempDatabase;

/** What a run wrote. */
interface Captured {
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** Recorded text and the io that fills it. */
interface Capture {
  /** What was written. */
  captured: Captured;
  /** Output streams for the command. */
  io: CheckIo;
}

/**
 * Builds output that records what is written.
 * @returns Captured text and the io that fills it.
 */
function capture(): Capture {
  const captured: Captured = { stdout: '',
    stderr: '' };

  return { captured,
    io: {
      stdout: (text) => {
        captured.stdout += text;
      },
      stderr: (text) => {
        captured.stderr += text;
      },
    } };
}

/**
 * Builds the configuration of a test.
 * @param scenarios Scenarios the configuration chooses.
 * @param env Variables that replace the defaults.
 * @returns Configuration over the fake Hawk.
 */
function configFor(scenarios: string, env: Record<string, string | undefined> = {}): Config {
  return createTestDeps(hawk, { env: { SCENARIOS: scenarios,
    RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9100',
    RULE_CACHE_WARMUP_MS: '50',
    DATABASE_PATH: database.path,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_NOTIFY_URL: NOTIFY_URL,
    ...env } }).deps.config;
}

/**
 * Reads a stored change time.
 * @param key Key of the rule.
 * @returns The stored text, or undefined.
 */
function stored(key: string): string | undefined {
  const history = createHistory(openDatabase(database.path, { readOnly: true }));

  try {
    return history.getKv(key);
  } finally {
    history.close();
  }
}

/**
 * Lists the rules of the instance that send to Telegram.
 * @returns Rules T in the fake.
 */
function telegramRules(): ReturnType<FakeHawk['rules']['list']> {
  return hawk.rules.list(hawk.projectId).filter(rule => rule.channels.telegram.isEnabled);
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  database = await tempDatabase();
});

afterEach(async () => {
  await hawk.close();
  await database.remove();
});

describe('runProvisionCommand with telegram-delivery', () => {
  it('provisions rule T next to the two rules of check-notification and prints a field for each provisioner', async () => {
    const { captured, io } = capture();
    const code = await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery'), io, { resolveAddress: async () => Promise.resolve(ADDRESS) });
    const printed = JSON.parse(captured.stdout.trim()) as Record<string, unknown>;

    expect(code, captured.stderr).toBe(0);
    expect(printed).toMatchObject({ notification: { action: 'created',
      deleted: 0 },
    telegram: { action: 'created',
      deleted: 0 } });
    // The default rule of the project, the two of check-notification and rule T.
    expect(hawk.rules.list(hawk.projectId)).toHaveLength(4);
    expect(telegramRules()).toHaveLength(1);
    expect(telegramRules()[0]?.channels.telegram.endpoint).toBe(NOTIFY_URL);
  });

  it('a second run changes nothing and deletes nothing', async () => {
    const config = configFor('check-notification,telegram-delivery');

    await runProvisionCommand(NO_WAIT, config, capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    const { captured, io } = capture();

    expect(await runProvisionCommand(NO_WAIT, config, io, { resolveAddress: async () => Promise.resolve(ADDRESS) })).toBe(0);
    expect(JSON.parse(captured.stdout.trim())).toMatchObject({ notification: { action: 'none',
      deleted: 0 },
    telegram: { action: 'none',
      deleted: 0 } });
  });

  it('without telegram-delivery rule T is not made, read or deleted, and the output is the plain result', async () => {
    const { captured, io } = capture();

    expect(await runProvisionCommand(NO_WAIT, configFor('check-notification'), io, { resolveAddress: async () => Promise.resolve(ADDRESS) })).toBe(0);
    expect(JSON.parse(captured.stdout.trim())).toMatchObject({ action: 'created',
      matchChanged: true });
    expect(telegramRules()).toEqual([]);
  });

  it('an existing rule T stays untouched when telegram-delivery is not chosen', async () => {
    await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery'), capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    const [before] = telegramRules();
    const mutations = hawk.api.operations.length;

    await runProvisionCommand(NO_WAIT, configFor('check-notification'), capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    expect(telegramRules().map(rule => rule.id)).toEqual([before?.id]);
    expect(hawk.api.operations.slice(mutations).filter(name => /^(Create|Update|Delete)NotificationRule$/u.test(name))).toEqual([]);
  });

  it('records the change of each rule under its own key', async () => {
    await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery'), capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    expect(Number.isNaN(Date.parse(stored(MATCH_CHANGED_KEY) ?? ''))).toBe(false);
    expect(Number.isNaN(Date.parse(stored(TELEGRAM_MATCH_CHANGED_KEY) ?? ''))).toBe(false);
  });

  it('records only the Telegram key when only rule T changed', async () => {
    await runProvisionCommand(NO_WAIT, configFor('check-notification'), capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    const before = stored(MATCH_CHANGED_KEY);

    await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery'), capture().io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    expect(stored(MATCH_CHANGED_KEY)).toBe(before);
    expect(stored(TELEGRAM_MATCH_CHANGED_KEY)).toBeDefined();
  });

  it('waits once for the warmup of the rules it changed', async () => {
    const clock = createFakeClock();
    const { captured, io } = capture();
    const running = runProvisionCommand(WAIT, configFor('check-notification,telegram-delivery'), io, { clock,
      resolveAddress: async () => Promise.resolve(ADDRESS) });

    // The setup deadline and the warmup wait.
    await vi.waitFor(() => {
      expect(clock.pending()).toBe(2);
    });
    expect(captured.stderr).toContain('waiting 1 s for Hawk to reload notification rules');

    await clock.advance(50);

    expect(await running).toBe(0);
  });

  it('a missing token is a configuration error that names it, and nothing is created', async () => {
    const { captured, io } = capture();
    const code = await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery', { TELEGRAM_BOT_TOKEN: undefined }), io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    expect(code).toBe(1);
    expect(captured.stderr).toContain('TELEGRAM_BOT_TOKEN');
    expect(hawk.rules.list(hawk.projectId)).toHaveLength(1);
  });

  it('keeps the notify address and the token out of the output', async () => {
    const { captured, io } = capture();

    await runProvisionCommand(NO_WAIT, configFor('check-notification,telegram-delivery'), io, { resolveAddress: async () => Promise.resolve(ADDRESS) });

    expect(captured.stdout + captured.stderr).not.toContain('abc123');
    expect(captured.stdout + captured.stderr).not.toContain(TOKEN);
  });
});
