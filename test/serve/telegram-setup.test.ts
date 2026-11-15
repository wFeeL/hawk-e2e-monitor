import { afterEach, describe, expect, it } from 'vitest';
import { StartupError } from '../../src/app.js';
import { createMutableRedactor } from '../../src/errors/redact.js';
import { buildRunners } from '../../src/serve/runners.js';
import type { Closer, RunnerContext } from '../../src/serve/scenario-setup.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { systemClock } from '../../src/time/clock.js';
import { TEST_RECEIVER_SECRET } from '../support/env.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { memoryLogger } from '../support/logger.js';
import { createTestDeps } from '../support/scenario.js';

const TOKEN = '123456789:AAEhBOweik6ad9r_QXGnBiXrW0Q4Yp7yP1Z';
const NOTIFY_URL = 'https://notify.bot.codex.so/u/abc123';
const closers: Closer[] = [];
let hawk: FakeHawk | undefined;

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) {
    await close();
  }

  await hawk?.close();
  hawk = undefined;
});

/**
 * Builds the context of the runners for the given scenarios.
 * @param scenarios Comma-separated names the configuration enables.
 * @param env Variables that replace the test defaults; undefined removes one.
 * @returns Context over a fake Hawk and an in-memory history.
 */
async function contextFor(scenarios: string, env: Record<string, string | undefined> = {}): Promise<RunnerContext> {
  hawk = await startFakeHawk();

  const { deps } = createTestDeps(hawk, { env: { SCENARIOS: scenarios,
    RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9100',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_NOTIFY_URL: NOTIFY_URL,
    ...env } });

  return { config: { ...deps.config,
    notifications: { ...deps.config.notifications,
      receiverPort: 0 } },
  history: createHistory(openDatabase(':memory:')),
  clock: systemClock,
  logger: memoryLogger(),
  masking: createMutableRedactor([]),
  api: deps.api,
  collector: deps.collector,
  overrides: {},
  closers };
}

/**
 * Builds the runners and returns what the setup failed with.
 * @param context Context of the runners.
 * @returns The thrown startup error.
 */
async function startupError(context: RunnerContext): Promise<StartupError> {
  const error: unknown = await buildRunners(context).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(StartupError);

  return error as StartupError;
}

describe('setup of telegram-delivery', () => {
  it('builds a runner, the wait for the tunnel and the receiver check', async () => {
    const built = await buildRunners(await contextFor('telegram-delivery'));

    expect(Object.keys(built.runners)).toEqual(['telegram-delivery']);
    expect(Object.keys(built.beforeFirstRun)).toEqual(['telegram-delivery']);
    expect(built.readiness.map(check => check.name)).toEqual(['receiver']);
    expect(built.receiverPort).toBeGreaterThan(0);
  });

  it('with check-notification too, one receiver serves both: one port, one closer, one check, a wait for each', async () => {
    const built = await buildRunners(await contextFor('check-notification,telegram-delivery'));

    expect(Object.keys(built.runners)).toEqual(['check-notification', 'telegram-delivery']);
    expect(Object.keys(built.beforeFirstRun)).toEqual(['check-notification', 'telegram-delivery']);
    expect(closers).toHaveLength(1);
    expect(built.readiness.map(check => check.name)).toEqual(['receiver']);
  });

  it('names the missing token and notify address without printing them', async () => {
    const error = await startupError(await contextFor('telegram-delivery', { TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_NOTIFY_URL: undefined }));

    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(error.message).toContain('TELEGRAM_NOTIFY_URL');
  });

  it('names a malformed token or notify address and not their values', async () => {
    const error = await startupError(await contextFor('telegram-delivery', { TELEGRAM_BOT_TOKEN: 'secret-looking-junk',
      TELEGRAM_NOTIFY_URL: 'https://example.com/u/secretpath' }));

    expect(error.message).toContain('TELEGRAM_BOT_TOKEN');
    expect(error.message).toContain('TELEGRAM_NOTIFY_URL');
    expect(error.message).not.toContain('secret-looking-junk');
    expect(error.message).not.toContain('secretpath');
  });

  it('starts no receiver when the settings are wrong', async () => {
    await startupError(await contextFor('telegram-delivery', { TELEGRAM_BOT_TOKEN: undefined }));

    expect(closers).toHaveLength(0);
  });

  it('without telegram-delivery the variables are not looked at', async () => {
    const built = await buildRunners(await contextFor('send-and-receive-event', { TELEGRAM_BOT_TOKEN: 'junk' }));

    expect(Object.keys(built.runners)).toEqual(['send-and-receive-event']);
  });

  it('names the receiver variables when the scenario is chosen without them', async () => {
    const error = await startupError(await contextFor('telegram-delivery', { RECEIVER_SECRET: undefined }));

    expect(error.message).toContain('RECEIVER_SECRET');
  });
});
