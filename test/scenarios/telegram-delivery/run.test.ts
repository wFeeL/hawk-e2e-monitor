import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendProbe } from '../../../src/clients/codex-notify.js';
import { createTelegramClient } from '../../../src/clients/telegram.js';
import type { TelegramClient } from '../../../src/clients/telegram.js';
import type { RunResult, StageName } from '../../../src/engine/result.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { createProvisioner } from '../../../src/notifications/provisioning.js';
import { runTelegramDelivery } from '../../../src/scenarios/telegram-delivery/run.js';
import type { TelegramDeliveryDeps } from '../../../src/scenarios/telegram-delivery/run.js';
import { outcomeOf } from '../../../src/storage/outcome.js';
import { systemClock } from '../../../src/time/clock.js';
import { startFakeCodexNotify } from '../../support/fake-codex-notify.js';
import type { FakeCodexNotify } from '../../support/fake-codex-notify.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { startFakeTelegram } from '../../support/fake-telegram.js';
import type { FakeTelegram } from '../../support/fake-telegram.js';
import { createNotificationTestDeps } from '../../support/scenario.js';
import type { NotificationTestDeps } from '../../support/scenario.js';

const NOTIFY_ORIGIN = 'https://notify.bot.codex.so';

/** What a test may change about the run. */
interface StartOptions {
  /** Environment variables that replace the defaults. */
  env?: Record<string, string>;
  /** Whether rule T exists before the run, so the run sees no change and no warmup; true by default. */
  preProvision?: boolean;
  /** Changes the Telegram client of the run. */
  wrapClient?: (client: TelegramClient) => TelegramClient;
  /** Replaces the probe. */
  probe?: TelegramDeliveryDeps['sendProbe'];
}

/** Everything a run test works with. */
interface Started {
  /** Dependencies of `runTelegramDelivery`. */
  deps: TelegramDeliveryDeps;
  /** Fake Bot API. */
  telegram: FakeTelegram;
  /** Fake @codex_bot notify service. */
  codex: FakeCodexNotify;
  /** Notification parts of the run. */
  parts: NotificationTestDeps;
}

let hawk: FakeHawk;
const open: Array<() => Promise<void>> = [];

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await Promise.all(open.splice(0).map(async close => close()));
  await hawk.close();
});

/**
 * Builds the fakes and the dependencies of a run: Hawk's Telegram worker posts to the fake service, which puts the message into the fake chat.
 * @param options Environment, provisioning and replacements.
 * @returns Dependencies and the fakes.
 */
async function start(options: StartOptions = {}): Promise<Started> {
  const telegram = await startFakeTelegram();
  const codex = await startFakeCodexNotify({ telegram });
  const notifyUrl = `${NOTIFY_ORIGIN}/u/${codex.token}`;
  const parts = await createNotificationTestDeps(hawk, { preProvision: false,
    env: { TELEGRAM_API_URL: telegram.url,
      TELEGRAM_BOT_TOKEN: telegram.token,
      TELEGRAM_NOTIFY_URL: notifyUrl,
      TELEGRAM_DELIVERY_TIMEOUT_MS: '800',
      TELEGRAM_PROBE_TIMEOUT_MS: '800',
      ...options.env } });
  const { config } = parts.deps;
  const provisionerDeps = { api: parts.deps.api,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    loop: false,
    kinds: ['telegram'] as const,
    notifyUrl,
    warmupMs: config.notifications.ruleCacheWarmupMs,
    clock: systemClock };

  hawk.notifier.knobs.codexNotifyBase = codex.base;
  telegram.knobs.holdMs = 40;
  open.push(async () => parts.close(), async () => codex.close(), async () => telegram.close());

  const secret = config.notifications.receiverSecret ?? '';

  if (options.preProvision !== false) {
    await createProvisioner({ ...provisionerDeps,
      secret }).provision(parts.address, AbortSignal.timeout(5000));
  }

  const client = createTelegramClient({ apiUrl: telegram.url,
    token: telegram.token,
    httpTimeoutMs: config.httpTimeoutMs,
    clock: systemClock });

  return { deps: { ...parts.notificationDeps,
    provisioner: createProvisioner({ ...provisionerDeps,
      secret }),
    telegramClient: options.wrapClient?.(client) ?? client,
    // The notify address of the config is the real one, which a test must not call.
    sendProbe: options.probe ?? (async (url, text, probeDeps, signal) => sendProbe(url.replace(NOTIFY_ORIGIN, codex.base), text, probeDeps, signal)) },
  telegram,
  codex,
  parts };
}

/**
 * Lists the statuses of the stages of a run.
 * @param result Result of the run.
 * @returns Stage name and status pairs.
 */
function statuses(result: RunResult): Array<[StageName, string]> {
  return result.stages.map(stage => [stage.name, stage.status]);
}

/**
 * Finds a stage of a run.
 * @param result Result of the run.
 * @param name Stage to find.
 * @returns Its record.
 */
function stageOf(result: RunResult, name: StageName): RunResult['stages'][number] | undefined {
  return result.stages.find(stage => stage.name === name);
}

describe('runTelegramDelivery', () => {
  it('a healthy run: the message and the webhook arrive, the probe is skipped', async () => {
    const { deps, parts } = await start();
    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'telegram-delivery',
      provisioning: { action: 'none',
        deleted: 0,
        matchChanged: false } });
    expect(statuses(result)).toEqual([
      ['collector_availability', 'ok'],
      ['api_availability', 'ok'],
      ['telegram_ready', 'ok'],
      ['notification_setup', 'ok'],
      ['collector_accept', 'ok'],
      ['event_visible', 'ok'],
      ['notification_formed', 'ok'],
      ['telegram_delivered', 'ok'],
      ['telegram_probe', 'skipped'],
      ['cleanup', 'ok'],
    ]);
    expect(result.telegram?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.telegram?.unmatched).toBe(0);
    expect(result.telegram?.probe).toBeUndefined();
    expect(result.notification?.telegram?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(outcomeOf(result, { loopEnabled: false })).toMatchObject({ status: 'ok',
      degraded: [] });
    expect(parts.receiver.counts(result.runId).telegram).toEqual([]);
  });

  it('keeps the bot token, the notify address and its token out of the result', async () => {
    const { deps, telegram, codex } = await start();
    const text = JSON.stringify(await runTelegramDelivery(deps, { sequence: 1 }));

    expect(text).not.toContain(telegram.token);
    expect(text).not.toContain(codex.token);
  });

  it('a Hawk Telegram worker that is down: the probe arrives and the run is telegram_not_delivered', async () => {
    const { deps } = await start();

    hawk.notifier.knobs.telegramWorkerDown = true;

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'telegram_delivered',
      errorClass: 'telegram_not_delivered',
      culprit: 'hawk' });
    expect(result.message).toContain('a direct @codex_bot message arrived in');
    expect(stageOf(result, 'notification_formed')?.status).toBe('ok');
    expect(stageOf(result, 'telegram_delivered')).toMatchObject({ status: 'failed',
      errorClass: 'telegram_not_delivered' });
    expect(stageOf(result, 'telegram_probe')?.status).toBe('ok');
    expect(result.telegram?.probe?.arrivedMs).toBeGreaterThanOrEqual(0);
    expect(result.telegram?.latencyMs).toBeUndefined();
  });

  it('a message that comes after the delivery time, while the probe is awaited, is reported as late', async () => {
    const { deps } = await start({ probe: async () => Promise.resolve() });

    hawk.notifier.knobs.delayMs = { telegram: 1100 };

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'telegram_delivered',
      errorClass: 'telegram_not_delivered' });
    expect(result.message).toMatch(/arrived after \d+ ms, later than TELEGRAM_DELIVERY_TIMEOUT_MS/u);
    expect(result.telegram?.probe?.lateHawkMessageMs).toBeGreaterThan(800);
  });

  it('a probe that the service refuses names the config when the token is unknown', async () => {
    const { deps } = await start({ probe: async () => Promise.reject(new CheckError('telegram_bot_unavailable', { status: 404 }, { culprit: 'config' })) });

    hawk.notifier.knobs.telegramWorkerDown = true;

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'telegram_probe',
      errorClass: 'telegram_bot_unavailable',
      culprit: 'config' });
  });

  it('a probe that never arrives while the chat reads fine is telegram_bot_unavailable', async () => {
    const { deps } = await start({ probe: async () => Promise.resolve() });

    hawk.notifier.knobs.telegramWorkerDown = true;

    expect(await runTelegramDelivery(deps, { sequence: 1 })).toMatchObject({ status: 'failed',
      failedStage: 'telegram_probe',
      errorClass: 'telegram_bot_unavailable',
      culprit: 'network' });
  });

  it('a webhook of rule T that does not come, with the message there, is ok and degraded to a single channel', async () => {
    const { deps } = await start();

    hawk.notifier.knobs.webhookOff = true;

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'notification_formed')).toMatchObject({ status: 'failed',
      errorClass: 'notification_timeout' });
    expect(outcomeOf(result, { loopEnabled: false }).degraded).toEqual(['single_channel']);
  });

  it('neither the message nor the webhook: the webhook failure is the result', async () => {
    const { deps } = await start();

    hawk.notifier.knobs.webhookOff = true;
    hawk.notifier.knobs.telegramWorkerDown = true;

    expect(await runTelegramDelivery(deps, { sequence: 1 })).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'notification_timeout' });
  });

  it('D3: a webhook on the bot is telegram_conflict, found before the event is sent', async () => {
    const { deps, telegram, codex } = await start();

    telegram.knobs.webhookUrl = 'https://hooks.example.com/bot';

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'telegram_ready',
      errorClass: 'telegram_conflict',
      culprit: 'config' });
    expect(stageOf(result, 'collector_accept')?.status).toBe('skipped');
    expect(codex.requests).toEqual([]);
  });

  it('a bot with the privacy mode on is telegram_bot_misconfigured', async () => {
    const { deps, telegram } = await start();

    telegram.knobs.privacyOn = true;

    expect(await runTelegramDelivery(deps, { sequence: 1 })).toMatchObject({ failedStage: 'telegram_ready',
      errorClass: 'telegram_bot_misconfigured' });
  });

  it('D3: a 409 in the middle of telegram_delivered is telegram_conflict', async () => {
    let reads = 0;
    const { deps } = await start({ wrapClient: client => ({ ...client,
      getUpdates: async (offset, timeoutS, signal) => {
        reads += 1;

        if (reads > 1) {
          throw new CheckError('telegram_conflict', { detail: 'another reader' });
        }

        return client.getUpdates(offset, timeoutS, signal);
      } }) });

    hawk.notifier.knobs.telegramWorkerDown = true;

    expect(await runTelegramDelivery(deps, { sequence: 1 })).toMatchObject({ status: 'failed',
      failedStage: 'telegram_delivered',
      errorClass: 'telegram_conflict' });
  });

  it('row 6b: a read that hangs past the limit of telegram_delivered never gives ok', async () => {
    let reads = 0;
    const { deps } = await start({ env: { HTTP_TIMEOUT_MS: '200',
      TELEGRAM_DELIVERY_TIMEOUT_MS: '300' },
    wrapClient: client => ({ ...client,
      getUpdates: async (offset, timeoutS, signal) => {
        reads += 1;

        if (reads === 1) {
          return client.getUpdates(offset, timeoutS, signal);
        }

        return new Promise<never>(() => undefined);
      } }) });

    hawk.notifier.knobs.telegramWorkerDown = true;

    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result.status).toBe('failed');
    expect(result.failedStage).toBe('telegram_delivered');
  });

  it('rule cache warmup: the webhook, the message and the probe are skipped, and the run is stored as skipped', async () => {
    const { deps, telegram } = await start({ preProvision: false });
    const result = await runTelegramDelivery(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'ok',
      provisioning: { action: 'created',
        matchChanged: true } });
    for (const name of ['notification_formed', 'telegram_delivered', 'telegram_probe'] as const) {
      expect(stageOf(result, name)).toMatchObject({ status: 'skipped' });
    }

    expect(stageOf(result, 'notification_formed')?.details?.reason).toBe('rule_cache_warmup');
    expect(stageOf(result, 'telegram_ready')?.status).toBe('ok');
    expect(outcomeOf(result, { loopEnabled: false })).toMatchObject({ status: 'skipped',
      skipReason: 'rule_cache_warmup' });
    expect(telegram.requests.filter(request => request.method === 'getUpdates')).toHaveLength(1);
  });
});
