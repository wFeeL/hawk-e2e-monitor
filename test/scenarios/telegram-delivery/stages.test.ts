import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendProbe } from '../../../src/clients/codex-notify.js';
import { createTelegramClient } from '../../../src/clients/telegram.js';
import { runStage } from '../../../src/engine/stages.js';
import type { StageResult } from '../../../src/engine/result.js';
import type { StageSpec } from '../../../src/engine/stages.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { planRun } from '../../../src/scenarios/shared/plan.js';
import { UNREADABLE_REGISTRATIONS, notificationBeforeSend } from '../../../src/scenarios/check-notification/stages.js';
import { probeText, telegramDeliveredStage, telegramFormedStage, telegramProbeStage, telegramReadyStage } from '../../../src/scenarios/telegram-delivery/stages.js';
import type { TelegramContext } from '../../../src/scenarios/telegram-delivery/stages.js';
import type { Clock } from '../../../src/time/clock.js';
import { systemClock } from '../../../src/time/clock.js';
import { httpAddress } from '../../support/address.js';
import { TEST_RECEIVER_SECRET } from '../../support/env.js';
import { createFakeClock } from '../../support/fake-clock.js';
import type { FakeClock } from '../../support/fake-clock.js';
import { startFakeCodexNotify } from '../../support/fake-codex-notify.js';
import type { FakeCodexNotify } from '../../support/fake-codex-notify.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { startDeadPort } from '../../support/dead-port.js';
import { createNotificationTestScenario } from '../../support/scenario.js';
import type { NotificationTestScenario } from '../../support/scenario.js';
import { startFakeTelegram } from '../../support/fake-telegram.js';
import type { FakeTelegram } from '../../support/fake-telegram.js';

const STAGE_MS = 60_000;
const REAL_DELIVERY_MS = 600;
const REAL_PROBE_MS = 600;

/** What a test may change about the world. */
interface WorldOptions {
  /** Clock of the run; the system one by default. */
  clock?: Clock;
  /** Environment variables that replace the defaults. */
  env?: Record<string, string>;
}

/** The fakes and the context a Telegram stage runs in. */
interface World {
  /** Context of the stages. */
  context: TelegramContext;
  /** Fake Bot API. */
  telegram: FakeTelegram;
  /** Fake @codex_bot notify service. */
  codex: FakeCodexNotify;
  /** Notification parts: the receiver and its address. */
  parts: NotificationTestScenario;
}

let hawk: FakeHawk;
const open: Array<() => Promise<void>> = [];

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map(async close => close()));
  await hawk.close();
});

/**
 * Builds the fakes and the context of a run of `telegram-delivery`.
 * @param options Clock and environment.
 * @returns Context, fakes and notification parts of the run.
 */
async function world(options: WorldOptions = {}): Promise<World> {
  const telegram = await startFakeTelegram();
  const codex = await startFakeCodexNotify({ telegram });
  const clock = options.clock ?? systemClock;
  const parts = await createNotificationTestScenario(hawk, { preProvision: false,
    clock,
    env: { TELEGRAM_API_URL: telegram.url,
      TELEGRAM_BOT_TOKEN: telegram.token,
      TELEGRAM_NOTIFY_URL: codex.url,
      // A fake clock waits the configured defaults out at no cost; the real one needs short waits.
      ...options.clock === undefined
        ? { TELEGRAM_DELIVERY_TIMEOUT_MS: String(REAL_DELIVERY_MS),
            TELEGRAM_PROBE_TIMEOUT_MS: String(REAL_PROBE_MS) }
        : {},
      ...options.env } });
  const { config } = parts.deps;

  // The real clock needs short long polls, or a poll outlives the wait.
  telegram.knobs.holdMs = options.clock === undefined ? 40 : 0;
  open.push(async () => parts.close(), async () => codex.close(), async () => telegram.close());

  const context: TelegramContext = { ...parts.context,
    plan: planRun(config, { sequence: 1 }, 'telegram-delivery', parts.deps.randomLetters),
    telegramClient: createTelegramClient({ apiUrl: telegram.url,
      token: telegram.token,
      httpTimeoutMs: config.httpTimeoutMs,
      clock }),
    sendProbe,
    telegram: { offset: 0,
      polls: 0,
      unmatched: 0 } };

  context.state.acceptedAtMs = clock.monotonicMs();

  return { context,
    telegram,
    codex,
    parts };
}

/**
 * Runs one stage under the engine on the clock of the context.
 * @param spec Stage to run.
 * @param context Context of the stage.
 * @returns Recorded result.
 */
async function run(spec: StageSpec<TelegramContext>, context: TelegramContext): Promise<StageResult> {
  return runStage(spec, context, { clock: context.clock,
    runSignal: new AbortController().signal });
}

/**
 * Pauses for real time, so a fake server and the stage can talk between two clock steps.
 * @param ms Time to wait.
 * @returns Resolves after the pause.
 */
async function realPause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Moves a fake clock in steps, with real pauses between them, until the stage is done.
 * @param clock Fake clock of the run.
 * @param running The running stage.
 * @param stepMs Fake time of one step.
 * @returns The stage result.
 */
async function drive(clock: FakeClock, running: Promise<StageResult>, stepMs = 10_000): Promise<StageResult> {
  let finished = false;

  void running.then(() => {
    finished = true;
  });

  for (let elapsed = 0; !finished && elapsed < 600_000; elapsed += stepMs) {
    await clock.advance(stepMs);
    await realPause(3);
  }

  return running;
}

/**
 * Builds the text Hawk's worker sends for the run.
 * @param context Context with the title.
 * @param title Title to put on the first line; the title of the run by default.
 * @returns Message text: title, code block, link line.
 */
function hawkText(context: TelegramContext, title = context.plan.title): string {
  return `${title}\n\n\`\`\`\nhawk-e2e-monitor/check.js\n\`\`\`\n[View details](http://garage.test/p/e/) | Fake project | 1 new (1 total)`;
}

/** What a test changes about the message of the Hawk worker. */
interface PushOverrides {
  /** Username of the sender. */
  fromUsername?: string;
  /** Whether the sender is a bot. */
  fromIsBot?: boolean;
  /** Id of the chat. */
  chatId?: number;
}

/**
 * Puts a message of the Hawk worker into the chat.
 * @param telegram Fake Bot API.
 * @param text Text of the message.
 * @param overrides Sender or chat to change.
 * @returns Id of the update.
 */
function pushHawk(telegram: FakeTelegram, text: string, overrides: PushOverrides = {}): number {
  return telegram.push({ fromUsername: 'codex_bot',
    fromIsBot: true,
    text,
    ...overrides });
}

/**
 * Lists the Bot API methods the fake saw, in order.
 * @param telegram Fake Bot API.
 * @returns Method names.
 */
function methods(telegram: FakeTelegram): string[] {
  return telegram.requests.map(request => request.method);
}

describe('telegramReadyStage', () => {
  it('asks getMe, the webhook and the updates in that order, and keeps the bot id and the offset', async () => {
    const { context, telegram } = await world();

    pushHawk(telegram, 'old');

    const last = pushHawk(telegram, 'older');
    const result = await run(telegramReadyStage(STAGE_MS), context);

    expect(result.status).toBe('ok');
    expect(methods(telegram)).toEqual(['getMe', 'getWebhookInfo', 'getUpdates']);
    expect(context.telegram.botId).toBe(telegram.botId);
    expect(context.telegram.offset).toBe(last + 1);
  });

  it('starts from offset 0 when the chat has no updates, never from -1', async () => {
    const { context } = await world();

    await run(telegramReadyStage(STAGE_MS), context);

    expect(context.telegram.offset).toBe(0);
  });

  it('a bot with the privacy mode on is telegram_bot_misconfigured', async () => {
    const { context, telegram } = await world();

    telegram.knobs.privacyOn = true;

    expect(await run(telegramReadyStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_misconfigured',
      culprit: 'config' });
    expect(methods(telegram)).toEqual(['getMe']);
  });

  it('a webhook is telegram_conflict', async () => {
    const { context, telegram } = await world();

    telegram.knobs.webhookUrl = 'https://hooks.example.com/bot';

    expect(await run(telegramReadyStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_conflict' });
  });

  it('asks for the status of the bot in the chat only when TELEGRAM_CHAT_ID is set, and wants an administrator', async () => {
    const without = await world();

    await run(telegramReadyStage(STAGE_MS), without.context);
    expect(methods(without.telegram)).not.toContain('getChatMember');

    const withChat = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    expect((await run(telegramReadyStage(STAGE_MS), withChat.context)).status).toBe('ok');
    expect(methods(withChat.telegram)).toEqual(['getMe', 'getWebhookInfo', 'getChatMember', 'getUpdates']);

    withChat.telegram.knobs.memberStatus = 'creator';
    expect((await run(telegramReadyStage(STAGE_MS), withChat.context)).status).toBe('ok');

    withChat.telegram.knobs.memberStatus = 'member';
    expect(await run(telegramReadyStage(STAGE_MS), withChat.context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_misconfigured' });
  });

  it('a chat the bot cannot find or was kicked from is telegram_bot_misconfigured that names TELEGRAM_CHAT_ID', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    for (const status of [400, 403]) {
      telegram.knobs.status = { getChatMember: status };

      const result = await run(telegramReadyStage(STAGE_MS), context);

      expect(result).toMatchObject({ status: 'failed',
        errorClass: 'telegram_bot_misconfigured',
        culprit: 'config' });
      expect(result.message).toContain('TELEGRAM_CHAT_ID');
      expect(result.message).toContain(`fake error ${String(status)}`);
      expect(result.message).not.toContain(telegram.token);
    }

    telegram.knobs.status = { getChatMember: 500 };
    expect(await run(telegramReadyStage(STAGE_MS), context)).toMatchObject({ errorClass: 'telegram_api_unavailable' });
  });

  it('a 409 on the drain is telegram_conflict, a 401 is telegram_auth_failed, a 500 is telegram_api_unavailable', async () => {
    const { context, telegram } = await world();

    for (const [status, errorClass] of [[409, 'telegram_conflict'], [401, 'telegram_auth_failed'], [500, 'telegram_api_unavailable']] as const) {
      telegram.knobs.status = { getUpdates: status };
      expect(await run(telegramReadyStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
        errorClass });
    }
  });

  it('a 429 on the drain is telegram_api_unavailable', async () => {
    const { context, telegram } = await world();

    telegram.knobs.status = { getUpdates: 429 };

    expect(await run(telegramReadyStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_api_unavailable' });
  });
});

describe('telegramDeliveredStage', () => {
  it('finds the message of the run, with its latency from the accept', async () => {
    const { context, telegram } = await world();
    const running = run(telegramDeliveredStage(STAGE_MS), context);

    await realPause(30);
    pushHawk(telegram, hawkText(context));

    const result = await running;

    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ latencyMs: expect.any(Number) as number });
    expect(context.telegram).toMatchObject({ found: true,
      lastReadOk: true,
      unmatched: 0 });
    expect(context.telegram.latencyMs).toBeGreaterThanOrEqual(20);
  });

  it('counts the message of an older run in unmatched, does not stop on it, and does not read it again', async () => {
    const { context, telegram } = await world();
    const older = pushHawk(telegram, hawkText(context, '[e2e:test] rzzzzzzzzzzzzzzzz telegram-delivery'));
    const running = run(telegramDeliveredStage(STAGE_MS), context);

    await realPause(80);
    pushHawk(telegram, hawkText(context));

    expect((await running).status).toBe('ok');
    expect(context.telegram.unmatched).toBe(1);

    const offsets = telegram.requests.filter(request => request.method === 'getUpdates').map(request => Number(request.params.offset));

    expect(offsets[0]).toBe(0);
    expect(offsets.slice(1).every(offset => offset > older)).toBe(true);
  });

  it('ignores a human and a title that is only on a later line, as plain unmatched messages', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    pushHawk(telegram, hawkText(context), { fromIsBot: false });
    pushHawk(telegram, `something else\n${context.plan.title}`);
    pushHawk(telegram, 'a message of another run');

    const result = await run(telegramDeliveredStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_not_delivered' });
    expect(context.telegram.unmatched).toBe(3);
    expect(context.telegram.misdirected).toBeUndefined();
  });

  it('a message of the run from another sender is telegram_bot_misconfigured that names the sender and the chat', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    pushHawk(telegram, hawkText(context), { fromUsername: 'someone_bot' });

    const result = await run(telegramDeliveredStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_misconfigured',
      culprit: 'config' });
    expect(result.message).toContain('someone_bot');
    expect(result.message).toContain('-1001');
    expect(result.message).toContain('TELEGRAM_SENDER_USERNAME');
    expect(result.message).toContain('TELEGRAM_CHAT_ID');
    expect(context.telegram.unmatched).toBe(1);
  });

  it('a message of the run in another chat is telegram_bot_misconfigured that names that chat', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    pushHawk(telegram, hawkText(context), { chatId: -1002 });

    const result = await run(telegramDeliveredStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_misconfigured' });
    expect(result.message).toContain('-1002');
    expect(context.telegram.misdirected).toEqual({ chatId: -1002,
      fromUsername: 'codex_bot' });
  });

  it('a misdirected message does not hide the right one: the stage is ok', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    pushHawk(telegram, hawkText(context), { fromUsername: 'someone_bot' });
    pushHawk(telegram, hawkText(context));

    expect((await run(telegramDeliveredStage(STAGE_MS), context)).status).toBe('ok');
  });

  it('matches a first line that still has the Markdown escapes', async () => {
    const { context, telegram } = await world();

    pushHawk(telegram, hawkText(context, context.plan.title.replace('[', String.raw`\[`)));

    expect((await run(telegramDeliveredStage(STAGE_MS), context)).status).toBe('ok');
  });

  it('with nothing in the chat and good reads it fails telegram_not_delivered with the counts', async () => {
    const { context } = await world();
    const result = await run(telegramDeliveredStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_not_delivered',
      culprit: 'hawk',
      details: { lastReadOk: true,
        unmatched: 0 } });
    expect(Number(result.details?.polls)).toBeGreaterThan(0);
    expect(context.telegram).toMatchObject({ found: false,
      lastReadOk: true });
  });

  it('on a fake clock, a Hawk worker that is down for the whole wait is telegram_not_delivered, not telegram_api_unavailable', async () => {
    const clock = createFakeClock();
    const { context } = await world({ clock });
    const result = await drive(clock, run(telegramDeliveredStage(150_000), context));

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_not_delivered',
      details: { lastReadOk: true } });
  });

  it('fails telegram_api_unavailable when the last read failed', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock });

    telegram.knobs.status = { getUpdates: 500 };

    const result = await drive(clock, run(telegramDeliveredStage(150_000), context));

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_api_unavailable',
      details: { lastReadOk: false } });
    expect(context.telegram.lastReadOk).toBe(false);
  });

  it('pauses one HTTP timeout after a failed read, and the retry after a 429', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock });
    const reads = (): number => telegram.requests.filter(request => request.method === 'getUpdates').length;

    telegram.knobs.status = { getUpdates: 500 };

    const running = run(telegramDeliveredStage(150_000), context);

    // The stage's own limit is one sleeper; the pause after a failed read is a second one.
    const paused = async (): Promise<void> => vi.waitFor(() => {
      expect(clock.pending()).toBeGreaterThanOrEqual(2);
    });

    await vi.waitFor(() => {
      expect(reads()).toBe(1);
    });
    await paused();
    // HTTP_TIMEOUT_MS of the test config is 1000 ms.
    await clock.advance(999);
    await realPause(40);
    expect(reads()).toBe(1);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(reads()).toBe(2);
    });
    await paused();

    telegram.knobs.status = { getUpdates: 429 };
    telegram.knobs.retryAfter = 7;
    await clock.advance(1000);
    await vi.waitFor(() => {
      expect(reads()).toBe(3);
    });
    await paused();
    await clock.advance(6999);
    await realPause(40);
    expect(reads()).toBe(3);
    await clock.advance(1);
    await vi.waitFor(() => {
      expect(reads()).toBe(4);
    });

    await drive(clock, running);
  });

  it('a refused connection is a failed read with a pause, not an error of the stage', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock });
    const dead = createTelegramClient({ apiUrl: 'http://127.0.0.1:1',
      token: telegram.token,
      httpTimeoutMs: 1000,
      clock });
    const result = await drive(clock, run(telegramDeliveredStage(150_000), { ...context,
      telegramClient: dead }));

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_api_unavailable' });
  });

  it('a read cut by the abort of the stage is not a failed read', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock });

    telegram.knobs.delayMs = 200;

    // The stage limit is short, so its abort cuts the read that is in flight.
    const running = run(telegramDeliveredStage(2000), context);

    await realPause(260);
    await vi.waitFor(() => {
      expect(telegram.requests.length).toBeGreaterThan(1);
    });
    await clock.advance(2500);

    expect(await running).toMatchObject({ status: 'failed',
      errorClass: 'telegram_not_delivered',
      details: { lastReadOk: true } });
  });

  it('a read that stalls and then fails with a 500 after the deadline is a failed read, not the probe path', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock });

    telegram.knobs.delayMs = 200;

    const running = run(telegramDeliveredStage(150_000), context);

    await vi.waitFor(() => {
      expect(telegram.requests.length).toBeGreaterThan(0);
    });
    // The first read ends well; the next one stalls, the deadline passes, and then it fails.
    await realPause(260);
    telegram.knobs.status = { getUpdates: 500 };
    await vi.waitFor(() => {
      expect(telegram.requests.length).toBeGreaterThan(1);
    });
    await clock.advance(121_000);

    const result = await running;

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_api_unavailable',
      details: { lastReadOk: false } });
    expect(context.telegram.lastReadOk).toBe(false);
  });

  it('a 409 in the middle of the wait ends the stage at once with telegram_conflict', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_DELIVERY_TIMEOUT_MS: '5000' } });
    const running = run(telegramDeliveredStage(STAGE_MS), context);

    await realPause(80);
    telegram.knobs.status = { getUpdates: 409 };

    const result = await running;

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_conflict',
      culprit: 'config' });
    expect(context.telegram).toMatchObject({ found: false,
      lastReadOk: false });
  });

  it('a 401 ends the stage at once with telegram_auth_failed', async () => {
    const { context, telegram } = await world({ env: { TELEGRAM_DELIVERY_TIMEOUT_MS: '5000' } });

    telegram.knobs.status = { getUpdates: 401 };

    expect(await run(telegramDeliveredStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_auth_failed' });
  });

  it('is skipped in the rule cache warmup', async () => {
    const { context, telegram } = await world();

    context.notification.warmup = true;

    expect(await run(telegramDeliveredStage(STAGE_MS), context)).toMatchObject({ status: 'skipped',
      details: { reason: 'rule_cache_warmup' } });
    expect(telegram.requests).toEqual([]);
    expect(context.telegram.found).toBeUndefined();
  });

  it('asks for at most 10 s per long poll and for what is left of the delivery time', async () => {
    const clock = createFakeClock();
    const { context, telegram } = await world({ clock,
      env: { TELEGRAM_DELIVERY_TIMEOUT_MS: '25000' } });
    const result = await drive(clock, run(telegramDeliveredStage(60_000), context), 1000);

    expect(result.status).toBe('failed');

    const timeouts = telegram.requests.filter(request => request.method === 'getUpdates').map(request => Number(request.params.timeout));

    expect(timeouts[0]).toBe(10);
    expect(Math.max(...timeouts)).toBe(10);
    expect(timeouts.at(-1)).toBeLessThanOrEqual(10);
  });
});

/**
 * Makes the run ready for the probe: the webhook of rule T arrived and was fine, and the message of Hawk was not found.
 * @param context Context of the run.
 */
function readyForProbe(context: TelegramContext): void {
  context.state.sendOutcome = { kind: 'accepted',
    attempts: 1 };
  context.telegram.formedOk = true;
  context.telegram.found = false;
  context.telegram.lastReadOk = true;
  context.notification.arrivals = { webhook: [],
    loop: [],
    threshold: [],
    telegram: [{ channel: 'telegram',
      atMs: 1,
      headers: {},
      rawBody: '{}' }],
    unmatched: 0 };
}

describe('telegramProbeStage', () => {
  it('is skipped unless the notification was formed, the chat was read well and nothing came', async () => {
    const cases: Array<[string, (context: TelegramContext) => void]> = [
      ['message found', (context) => {
        context.telegram.found = true;
      }],
      ['last read failed', (context) => {
        context.telegram.lastReadOk = false;
      }],
      ['no webhook', (context) => {
        context.notification.arrivals = undefined;
      }],
      ['formed failed', (context) => {
        context.telegram.formedOk = false;
      }],
      ['warmup', (context) => {
        context.notification.warmup = true;
      }],
      ['delivery never decided', (context) => {
        context.telegram.found = undefined;
      }],
      ['accept only uncertain', (context) => {
        context.state.sendOutcome = { kind: 'uncertain',
          cause: new CheckError('collector_unavailable', {}),
          attempts: 1 };
        context.state.sendMayHaveReached = true;
      }],
      ['accept failed', (context) => {
        context.state.sendOutcome = { kind: 'rejected',
          error: new CheckError('bad_request', {}),
          attempts: 1 };
      }],
      ['no accept outcome', (context) => {
        context.state.sendOutcome = undefined;
      }],
      ['a message of the run came from the wrong place', (context) => {
        context.telegram.misdirected = { chatId: -1002 };
      }],
    ];

    for (const [name, spoil] of cases) {
      const { context, codex } = await world();

      readyForProbe(context);
      spoil(context);

      expect(await run(telegramProbeStage(STAGE_MS), context), name).toMatchObject({ status: 'skipped' });
      expect(codex.requests, name).toEqual([]);
    }
  });

  it('sends the probe text and sees it arrive, with the time it took', async () => {
    const { context, codex } = await world();

    readyForProbe(context);

    const result = await run(telegramProbeStage(STAGE_MS), context);

    expect(result.status).toBe('ok');
    expect(codex.requests[0]?.form.message).toBe(`[e2e:${context.config.instanceId}] ${context.plan.runId} telegram-delivery probe`);
    expect(codex.requests[0]?.form.message).toBe(probeText(context));
    expect(context.telegram.probe?.arrivedMs).toBeGreaterThanOrEqual(0);
    expect(context.telegram.probe?.sentAt).toMatch(/^\d{4}-/u);
    expect(context.telegram.probe?.lateHawkMessageMs).toBeUndefined();
  });

  it('a probe text from another sender or in another chat is telegram_bot_misconfigured, not a missing probe', async () => {
    const { context, codex, telegram } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    readyForProbe(context);
    codex.knobs.drop = true;
    pushHawk(telegram, probeText(context), { fromUsername: 'someone_bot' });

    const result = await run(telegramProbeStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_misconfigured',
      culprit: 'config' });
    expect(result.message).toContain('someone_bot');
    expect(result.message).toContain('TELEGRAM_SENDER_USERNAME');
  });

  it('a probe that arrives from the right sender in the right chat still passes', async () => {
    const { context } = await world({ env: { TELEGRAM_CHAT_ID: '-1001' } });

    readyForProbe(context);

    expect((await run(telegramProbeStage(STAGE_MS), context)).status).toBe('ok');
  });

  it('records a message of Hawk that comes while the probe is awaited', async () => {
    const { context, codex, telegram } = await world();

    readyForProbe(context);
    codex.knobs.drop = true;

    const running = run(telegramProbeStage(STAGE_MS), context);

    await realPause(80);
    pushHawk(telegram, hawkText(context));

    const result = await running;

    expect(result.status).toBe('ok');
    expect(context.telegram.probe?.lateHawkMessageMs).toBeGreaterThanOrEqual(0);
    expect(context.telegram.probe?.arrivedMs).toBeUndefined();
  });

  it('an unknown notify token is telegram_bot_unavailable with the config culprit, any other refusal with the network culprit', async () => {
    const { context, codex } = await world();

    readyForProbe(context);
    codex.knobs.status = 500;

    expect(await run(telegramProbeStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_unavailable',
      culprit: 'network' });

    const found404 = await world();

    readyForProbe(found404.context);

    const unknownToken = { ...found404.context,
      config: { ...found404.context.config,
        scenarios: { ...found404.context.config.scenarios,
          telegramDelivery: { ...found404.context.config.scenarios.telegramDelivery,
            notifyUrl: `${found404.codex.base}/u/unknownToken1` } } } };

    expect(await run(telegramProbeStage(STAGE_MS), unknownToken)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_unavailable',
      culprit: 'config' });
  });

  it('a probe that never arrives with good reads is telegram_bot_unavailable (network)', async () => {
    const { context, codex } = await world();

    readyForProbe(context);
    codex.knobs.drop = true;

    expect(await run(telegramProbeStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_bot_unavailable',
      culprit: 'network',
      details: { readsOk: true } });
  });

  it('a probe that never arrives while the reads fail is telegram_api_unavailable', async () => {
    const clock = createFakeClock();
    const { context, codex, telegram } = await world({ clock });

    readyForProbe(context);
    codex.knobs.drop = true;
    telegram.knobs.status = { getUpdates: 500 };

    const result = await drive(clock, run(telegramProbeStage(STAGE_MS), context), 5000);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'telegram_api_unavailable',
      details: { readsOk: false } });
  });

  it('a 409 during the probe wait is telegram_conflict', async () => {
    const { context, codex, telegram } = await world();

    readyForProbe(context);
    codex.knobs.drop = true;
    telegram.knobs.status = { getUpdates: 409 };

    expect(await run(telegramProbeStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'telegram_conflict' });
  });
});

describe('telegramFormedStage', () => {
  /**
   * Registers the run, sends nothing, and posts a body to the Telegram path of the receiver.
   * @param parts Notification parts.
   * @param text Raw body of the POST.
   * @param headers Request headers.
   */
  async function postTelegram(parts: NotificationTestScenario, text: string, headers: Record<string, string> = Object.fromEntries([['user-agent', 'Hawk-Webhook/1.0'], ['x-hawk-notification', 'event']])): Promise<void> {
    const response = await fetch(`${parts.address.baseUrl}/hooks/telegram/${TEST_RECEIVER_SECRET}`, { method: 'POST',
      headers,
      body: text });

    await response.arrayBuffer();
  }

  /**
   * Builds a webhook body as Hawk sends it.
   * @param context Context with the title and the project.
   * @param title Title to put in the body.
   * @returns JSON text.
   */
  function body(context: TelegramContext, title = context.plan.title): string {
    return JSON.stringify({ type: 'event',
      payload: { project: { id: context.config.hawk.projectId },
        events: [{ event: { id: 'e'.repeat(24),
          title } }] } });
  }

  /**
   * Registers the run with the receiver, the way the accept stage does.
   * @param context Context of the run.
   */
  function register(context: TelegramContext): void {
    context.address ??= undefined;
    notificationBeforeSend(context)();
  }

  it('waits for the webhook of rule T, checks it and records the latency', async () => {
    const { context, parts } = await world();

    register(context);
    context.state.acceptedAtMs = context.clock.monotonicMs();

    const running = run(telegramFormedStage(STAGE_MS), context);

    await realPause(30);
    await postTelegram(parts, body(context));

    const result = await running;

    expect(result.status).toBe('ok');
    expect(result.details?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(context.telegram.formedOk).toBe(true);
    expect(context.notification.arrivals?.telegram).toHaveLength(1);
  });

  it('a webhook with another title is notification_mismatch', async () => {
    const { context, parts } = await world();

    register(context);
    // The body names the run, so the receiver binds it, but its title is not ours.
    await postTelegram(parts, body(context, `other ${context.plan.runId}`));

    expect(await run(telegramFormedStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'notification_mismatch' });
    expect(context.telegram.formedOk).toBeUndefined();
  });

  it('no webhook within the time is notification_timeout', async () => {
    const { context, parts } = await world();

    context.address = parts.address;
    register(context);

    expect(await run(telegramFormedStage(STAGE_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'notification_timeout' });
  });

  it('a grown tunnel counter with no webhook is tunnel_reconnected', async () => {
    const { context, parts } = await world();

    context.address = httpAddress(parts.receiver.port, 'tunnel');
    context.tunnelRegistrations = () => Promise.resolve(4);
    context.notification.registrationsAtSetup = 3;
    register(context);

    const result = await run(telegramFormedStage(STAGE_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'tunnel_reconnected',
      culprit: 'network' });
    expect(result.message).toContain('registrations 3 → 4');
  });

  it('a counter that fell makes it tunnel_reconnected', async () => {
    const { context, parts } = await world();

    context.address = httpAddress(parts.receiver.port, 'tunnel');
    context.tunnelRegistrations = () => Promise.resolve(1);
    context.notification.registrationsAtSetup = 3;
    register(context);

    const result = await run(telegramFormedStage(STAGE_MS), context);

    expect(result.errorClass).toBe('tunnel_reconnected');
    expect(result.message).toContain('registrations 3 → 1');
  });

  it('an unreadable tunnel counter and a failed probe keep receiver_unreachable and warn', async () => {
    const { context } = await world();
    const dead = await startDeadPort();

    try {
      context.address = httpAddress(dead.port, 'tunnel');
      context.tunnelRegistrations = () => Promise.resolve(undefined);
      context.notification.registrationsAtSetup = 3;
      register(context);

      const result = await run(telegramFormedStage(STAGE_MS), context);

      expect(result.errorClass).toBe('receiver_unreachable');
      expect(result.details?.warning).toBe(UNREADABLE_REGISTRATIONS);
    } finally {
      dead.server.closeAllConnections();
      dead.server.close();
    }
  });

  it('is skipped in the rule cache warmup, with the details the scheduler reads', async () => {
    const { context } = await world();

    context.notification.warmup = true;
    context.notification.ruleChangedAgoMs = 10_000;

    expect(await run(telegramFormedStage(STAGE_MS), context)).toMatchObject({ status: 'skipped',
      details: { reason: 'rule_cache_warmup',
        warmupRemainingMs: context.settings.ruleCacheWarmupMs - 10_000 } });
  });
});
