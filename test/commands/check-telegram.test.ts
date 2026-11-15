import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheckCommand } from '../../src/commands/check.js';
import type { CheckIo } from '../../src/commands/check.js';
import type { CheckCommand } from '../../src/cli.js';
import { sendProbe } from '../../src/clients/codex-notify.js';
import type { RunResult } from '../../src/engine/result.js';
import { createProvisioner } from '../../src/notifications/provisioning.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../../src/storage/keys.js';
import { systemClock } from '../../src/time/clock.js';
import { tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { startFakeCodexNotify } from '../support/fake-codex-notify.js';
import type { FakeCodexNotify } from '../support/fake-codex-notify.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { startFakeTelegram } from '../support/fake-telegram.js';
import type { FakeTelegram } from '../support/fake-telegram.js';
import { createNotificationTestDeps } from '../support/scenario.js';
import type { NotificationTestDeps } from '../support/scenario.js';

const COMMAND: CheckCommand = { kind: 'check',
  scenario: 'telegram-delivery',
  sequence: 1,
  repeat: false };
const NOTIFY_ORIGIN = 'https://notify.bot.codex.so';

/** What a run of the command wrote and returned. */
interface Captured {
  /** Exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** What a test may change about the run. */
interface RunOptions {
  /** Whether rule T exists before the run; true by default. */
  preProvision?: boolean;
  /** Environment variables that replace the defaults. */
  env?: Record<string, string | undefined>;
}

let hawk: FakeHawk;
let database: TempDatabase;
let telegram: FakeTelegram;
let codex: FakeCodexNotify;
let parts: NotificationTestDeps | undefined;

beforeEach(async () => {
  hawk = await startFakeHawk();
  database = await tempDatabase();
  telegram = await startFakeTelegram();
  codex = await startFakeCodexNotify({ telegram });
  telegram.knobs.holdMs = 40;
  hawk.notifier.knobs.codexNotifyBase = codex.base;
});

afterEach(async () => {
  await parts?.close();
  parts = undefined;
  await database.remove();
  await codex.close();
  await telegram.close();
  await hawk.close();
});

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
 * Stores a change time under a key.
 * @param key Key of the rule.
 * @param offsetMs Distance from now; negative for the past.
 */
function store(key: string, offsetMs: number): void {
  const history = createHistory(openDatabase(database.path));

  history.setKv(key, new Date(Date.now() + offsetMs).toISOString());
  history.close();
}

/**
 * Runs `check telegram-delivery` on the fakes and captures its output.
 * @param options Provisioning and environment.
 * @returns Exit code and both streams.
 */
async function run(options: RunOptions = {}): Promise<Captured> {
  const notifyUrl = `${NOTIFY_ORIGIN}/u/${codex.token}`;
  const env = { DATABASE_PATH: database.path,
    TELEGRAM_API_URL: telegram.url,
    TELEGRAM_BOT_TOKEN: telegram.token,
    TELEGRAM_NOTIFY_URL: notifyUrl,
    TELEGRAM_DELIVERY_TIMEOUT_MS: '800',
    TELEGRAM_PROBE_TIMEOUT_MS: '800',
    RULE_CACHE_WARMUP_MS: '300',
    ...options.env } as Record<string, string>;
  const setup = await createNotificationTestDeps(hawk, { preProvision: false,
    env });

  parts = setup;

  if (options.preProvision !== false) {
    await createProvisioner({ api: setup.deps.api,
      clock: systemClock,
      projectId: setup.deps.config.hawk.projectId,
      instanceId: setup.deps.config.instanceId,
      secret: setup.deps.config.notifications.receiverSecret ?? '',
      loop: false,
      kinds: ['telegram'],
      notifyUrl,
      warmupMs: 300 }).provision(setup.address, AbortSignal.timeout(5000));
  }

  const captured: Captured = { code: -1,
    stdout: '',
    stderr: '' };
  const io: CheckIo = {
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  };

  captured.code = await runCheckCommand(COMMAND, setup.deps.config, io, { receiver: setup.receiver,
    resolveAddress: setup.resolveAddress,
    pollScheduleMs: setup.deps.pollScheduleMs,
    sendProbe: async (url, text, probeDeps, signal) => sendProbe(url.replace(NOTIFY_ORIGIN, codex.base), text, probeDeps, signal) });

  return captured;
}

describe('runCheckCommand with telegram-delivery', () => {
  it('prints the result of the scenario and exits 0', async () => {
    const { code, stdout, stderr } = await run();
    const result = JSON.parse(stdout) as RunResult;

    expect(code, stderr).toBe(0);
    expect(result).toMatchObject({ scenario: 'telegram-delivery',
      status: 'ok' });
    expect(result.telegram?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(stderr).toContain('ok\n');
  });

  it('exits 1 with the failed stage and class when the worker of Hawk is down', async () => {
    hawk.notifier.knobs.telegramWorkerDown = true;

    const { code, stdout, stderr } = await run();

    expect(code).toBe(1);
    expect((JSON.parse(stdout) as RunResult).errorClass).toBe('telegram_not_delivered');
    expect(stderr).toContain('failed telegram_delivered telegram_not_delivered:');
  });

  it('keeps the bot token and the notify token out of both streams', async () => {
    hawk.notifier.knobs.telegramWorkerDown = true;

    const { stdout, stderr } = await run({ env: { LOG_LEVEL: 'debug' } });

    for (const secret of [telegram.token, codex.token]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });

  it('a check that creates the rule records the change under the Telegram key only, and says the notification was not checked', async () => {
    const { code, stderr } = await run({ preProvision: false });

    expect(code, stderr).toBe(0);
    expect(Number.isNaN(Date.parse(stored(TELEGRAM_MATCH_CHANGED_KEY) ?? ''))).toBe(false);
    expect(stored(MATCH_CHANGED_KEY)).toBeUndefined();
    expect(stderr).toContain('notification not checked: rule cache warmup');
  });

  it('a check right after a change of rule T waits out the warmup and then checks', async () => {
    store(TELEGRAM_MATCH_CHANGED_KEY, -100);

    const startedAt = Date.now();
    const { code, stdout, stderr } = await run();
    const result = JSON.parse(stdout.trimEnd()) as RunResult;

    expect(code, stderr).toBe(0);
    expect(stderr).toContain('waiting 1 s for Hawk to reload notification rules\n');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(result.stages.find(stage => stage.name === 'telegram_delivered')?.status).toBe('ok');
  });

  it('a recent change of the other rule is not waited for', async () => {
    store(MATCH_CHANGED_KEY, -100);

    const { code, stderr } = await run();

    expect(code, stderr).toBe(0);
    expect(stderr).not.toContain('waiting');
  });

  it('a missing token is a configuration error that names it, and nothing runs', async () => {
    const { code, stdout, stderr } = await run({ env: { TELEGRAM_BOT_TOKEN: undefined } });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('TELEGRAM_BOT_TOKEN');
    expect(hawk.collector.posts).toBe(0);
  });
});
