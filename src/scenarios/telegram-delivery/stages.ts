import type { sendProbe } from '../../clients/codex-notify.js';
import type { TelegramClient, TelegramMessage } from '../../clients/telegram.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError, isCheckError } from '../../errors/taxonomy.js';
import type { ErrorClass } from '../../errors/taxonomy.js';
import { probeReceiver } from '../../notifications/address.js';
import { formatDuration } from '../../time/format.js';
import { MS_PER_SECOND } from '../../time/units.js';
import { checkWebhook } from '../check-notification/stages.js';
import type { NotificationContext } from '../check-notification/stages.js';

const LONG_POLL_MAX_S = 10;
const MARKDOWN_ESCAPES = /\\([_*`[])/gu;
const ADMIN_STATUSES: readonly string[] = ['administrator', 'creator'];
// Reasons that end a stage at once: waiting longer cannot help.
const ENDING_CLASSES: readonly ErrorClass[] = ['telegram_conflict', 'telegram_auth_failed', 'telegram_bot_misconfigured'];

/** The probe a failed delivery sends through @codex_bot, and what came of it. */
export interface ProbeState {
  /** Wall-clock time the probe was sent, ISO. */
  sentAt: string;
  /** Time from the send to the arrival of the probe in the chat. */
  arrivedMs?: number;
  /** Time from the collector's answer to a message of Hawk that came while the probe was awaited. */
  lateHawkMessageMs?: number;
  /** Whether the last read of the probe wait worked. */
  readsOk?: boolean;
}

/** What the Telegram stages learn on the way and hand to later stages and the verdict. */
export interface TelegramState {
  /** Next update to read; the drain of `telegram_ready` sets it. */
  offset: number;
  /** Id of the bot, set by `telegram_ready`. */
  botId?: number;
  /** Whether the message of Hawk was found; absent while the stage has not decided. */
  found?: boolean;
  /** Whether the last read of `telegram_delivered` worked. */
  lastReadOk?: boolean;
  /** Time from the collector's answer to the message of Hawk. */
  latencyMs?: number;
  /** Reads that got an answer. */
  polls: number;
  /** Messages of the chat that were not the one awaited. */
  unmatched: number;
  /** Whether the webhook of rule T arrived and passed its checks. */
  formedOk?: boolean;
  /** The probe, when one was sent. */
  probe?: ProbeState;
}

/** Everything a Telegram stage needs. */
export interface TelegramContext extends NotificationContext {
  /** Client of the Bot API. */
  telegramClient: TelegramClient;
  /** Sends the probe through @codex_bot. */
  sendProbe: typeof sendProbe;
  /** State of the Telegram stages. */
  telegram: TelegramState;
}

/** What `watch` found out. */
interface Watched {
  /** Whether the last read worked; absent when no read ended. */
  lastReadOk?: boolean;
  /** Why the last read failed. */
  lastError?: CheckError;
}

/**
 * Removes the backslashes of the Markdown escapes the Telegram worker adds.
 * @param text Text of a message.
 * @returns Text as Telegram renders it.
 */
export function unescapeMarkdown(text: string): string {
  return text.replaceAll(MARKDOWN_ESCAPES, '$1');
}

/**
 * Reads the first line of a message, where Hawk puts the title.
 * @param text Text of a message.
 * @returns The first line with its escapes removed.
 */
function firstLineOf(text: string): string {
  return unescapeMarkdown(text.split('\n')[0] ?? '');
}

/**
 * Tells whether a message is the notification of this run.
 * @param context Context with the title and the filters.
 * @param message Message read from the chat.
 * @returns True for a bot message from the sender, in the chat when one is set, whose first line is the title.
 */
function isHawkMessage(context: TelegramContext, message: TelegramMessage): boolean {
  const { chatId, senderUsername } = context.config.scenarios.telegramDelivery;

  return message.fromIsBot
    && message.fromUsername === senderUsername
    && (chatId === undefined || String(message.chatId) === chatId)
    && firstLineOf(message.text) === context.plan.title;
}

/**
 * Builds the text of the probe.
 * @param context Context with the instance id and the run id.
 * @returns The text; its first line is all of it.
 */
export function probeText(context: TelegramContext): string {
  return `[e2e:${context.config.instanceId}] ${context.plan.runId} telegram-delivery probe`;
}

/**
 * Sleeps without passing a deadline.
 * @param context Context with the clock.
 * @param ms Wanted pause.
 * @param deadlineMs Monotonic time the pause may not pass.
 * @param signal Ends the pause.
 * @returns True when the pause was made and there is time left.
 */
async function pauseBefore(context: TelegramContext, ms: number, deadlineMs: number, signal: AbortSignal): Promise<boolean> {
  const { clock } = context;
  const pauseMs = Math.min(ms, deadlineMs - clock.monotonicMs());

  if (pauseMs <= 0) {
    return false;
  }

  try {
    await clock.sleep(pauseMs, signal);
  } catch {
    return false;
  }

  return true;
}

/**
 * Reads the chat until `done` says so or the deadline comes, moving the offset past everything it reads.
 * A read that fails at or after the deadline was cut by it and does not count as failed.
 * @param context Context with the client, the clock and the state.
 * @param signal Ends the wait.
 * @param deadlineMs Monotonic time the wait ends at.
 * @param onMessage Sees each message and the time the read ended; true when the message is the one awaited.
 * @param done Tells after each read whether the wait is over.
 * @returns How the last read ended.
 * @throws CheckError that ends the stage: a conflict, a rejected token or a bot that lost its view.
 */
async function watch(context: TelegramContext, signal: AbortSignal, deadlineMs: number, onMessage: (message: TelegramMessage, atMs: number) => boolean, done: () => boolean): Promise<Watched> {
  const { clock, config, telegram, telegramClient } = context;
  const watched: Watched = {};

  while (!signal.aborted && !done()) {
    const leftMs = deadlineMs - clock.monotonicMs();

    if (leftMs <= 0) {
      break;
    }

    const timeoutS = Math.min(LONG_POLL_MAX_S, Math.ceil(leftMs / MS_PER_SECOND));
    let pauseMs = config.httpTimeoutMs;
    let read;

    try {
      read = await telegramClient.getUpdates(telegram.offset, timeoutS, signal);
    } catch (error) {
      if (!isCheckError(error)) {
        throw error;
      }

      if (ENDING_CLASSES.includes(error.errorClass)) {
        throw error;
      }

      if (signal.aborted || clock.monotonicMs() >= deadlineMs) {
        break;
      }

      watched.lastReadOk = false;
      watched.lastError = error;

      if (!await pauseBefore(context, pauseMs, deadlineMs, signal)) {
        break;
      }

      continue;
    }

    telegram.polls += 1;

    if (read.retryAfterS !== undefined) {
      pauseMs = read.retryAfterS * MS_PER_SECOND;
      watched.lastReadOk = false;
      watched.lastError = new CheckError('telegram_api_unavailable', { detail: `Telegram asked to wait ${String(read.retryAfterS)} s` });

      if (!await pauseBefore(context, pauseMs, deadlineMs, signal)) {
        break;
      }

      continue;
    }

    watched.lastReadOk = true;
    delete watched.lastError;
    telegram.offset = read.nextOffset;

    const atMs = clock.monotonicMs();

    for (const message of read.messages) {
      if (!onMessage(message, atMs)) {
        telegram.unmatched += 1;
      }
    }
  }

  return watched;
}

/**
 * Builds the error of a wait in which no read worked.
 * @param watched How the wait ended.
 * @returns The last failure of a read, or one that says no read ended.
 */
function readFailure(watched: Watched): CheckError {
  return watched.lastError ?? new CheckError('telegram_api_unavailable', { detail: 'no read of the chat ended before the deadline' });
}

/**
 * Stage `telegram_ready`: checks that the bot can see the group and drains what is in it, so the run reads only its own messages.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function telegramReadyStage(timeoutMs: number): StageSpec<TelegramContext> {
  return {
    name: 'telegram_ready',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { chatId } = context.config.scenarios.telegramDelivery;
      const { telegram, telegramClient } = context;
      const me = await telegramClient.getMe(signal);

      if (me.canReadAllGroupMessages !== true) {
        throw new CheckError('telegram_bot_misconfigured', { detail: 'the bot has the group privacy mode on, so it cannot read the messages of the group; turn the privacy mode off in BotFather' });
      }

      telegram.botId = me.id;

      const webhook = await telegramClient.webhookUrl(signal);

      if (webhook !== '') {
        throw new CheckError('telegram_conflict', { detail: 'the bot has a webhook, so getUpdates cannot read; delete the webhook' });
      }

      if (chatId !== undefined) {
        const status = await telegramClient.chatMemberStatus(chatId, me.id, signal);

        if (!ADMIN_STATUSES.includes(status)) {
          throw new CheckError('telegram_bot_misconfigured', { detail: `the bot is "${status}" in the chat from TELEGRAM_CHAT_ID, not an administrator` });
        }
      }

      const drained = await telegramClient.getUpdates(-1, 0, signal);

      if (drained.retryAfterS !== undefined) {
        throw new CheckError('telegram_api_unavailable', { detail: `Telegram asked to wait ${String(drained.retryAfterS)} s` });
      }

      // With nothing to drain the answer repeats -1, which would read the last update again later.
      telegram.offset = Math.max(drained.nextOffset, 0);

      return { status: 'ok',
        details: { botId: me.id,
          offset: telegram.offset } };
    },
  };
}

/**
 * Stage `notification_formed` of the Telegram rule: waits for its webhook and checks it.
 * @param timeoutMs Time limit of the stage; room for one probe after the wait.
 * @returns Stage spec.
 */
export function telegramFormedStage(timeoutMs: number): StageSpec<TelegramContext> {
  return {
    name: 'notification_formed',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, config, notification, plan, receiver, settings, state, telegram } = context;

      if (notification.warmup) {
        const ago = Math.ceil((notification.ruleChangedAgoMs ?? 0) / MS_PER_SECOND);

        return { status: 'skipped',
          details: { reason: 'rule_cache_warmup',
            warmupRemainingMs: Math.max(0, settings.ruleCacheWarmupMs - (notification.ruleChangedAgoMs ?? 0)),
            warning: `Notification check skipped: the notification rule changed ${String(ago)} s ago, Hawk caches rules for 60 s` } };
      }

      const startedMs = clock.monotonicMs();
      const arrivals = await receiver.wait(plan.runId, { channels: ['telegram'],
        timeoutMs: settings.timeoutMs,
        pairWaitMs: settings.pairWaitMs,
        signal });
      const [webhook] = arrivals.telegram;
      const details: Record<string, unknown> = { unmatched: arrivals.unmatched };

      notification.arrivals = arrivals;

      if (webhook === undefined) {
        const waitedMs = Math.round(clock.monotonicMs() - startedMs);

        details.waitedMs = waitedMs;

        try {
          if (context.address === undefined) {
            throw new CheckError('monitor_internal', { detail: 'notification_formed ran without a public address' });
          }

          await probeReceiver(context.address, settings.receiverSecret, receiver.nonce, { httpTimeoutMs: config.httpTimeoutMs,
            clock,
            attempts: 1,
            retry: config.retry }, signal);
        } catch (error) {
          if (isCheckError(error)) {
            return { status: 'failed',
              error,
              details };
          }

          throw error;
        }

        return { status: 'failed',
          error: new CheckError('notification_timeout', { detail: 'webhook_only',
            waitedMs }),
          details };
      }

      const problem = checkWebhook(webhook, plan.title, config.hawk.projectId);

      if (problem) {
        return { status: 'failed',
          error: problem,
          details };
      }

      telegram.formedOk = true;

      if (state.acceptedAtMs !== undefined) {
        details.latencyMs = Math.round(webhook.atMs - state.acceptedAtMs);
      }

      if (arrivals.unmatched > 0) {
        details.warnings = [`${String(arrivals.unmatched)} notification(s) with a valid secret but another run id arrived while waiting`];
      }

      return { status: 'ok',
        details };
    },
  };
}

/**
 * Stage `telegram_delivered`: reads the group until the notification of the run shows up or the delivery time is over.
 * @param timeoutMs Time limit of the stage, which leaves room for the last read after the delivery time.
 * @returns Stage spec.
 */
export function telegramDeliveredStage(timeoutMs: number): StageSpec<TelegramContext> {
  return {
    name: 'telegram_delivered',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, config, notification, state, telegram } = context;
      const { deliveryTimeoutMs, senderUsername } = config.scenarios.telegramDelivery;

      if (notification.warmup) {
        return { status: 'skipped',
          details: { reason: 'rule_cache_warmup' } };
      }

      const startedMs = clock.monotonicMs();
      let foundAtMs: number | undefined;
      let watched: Watched;

      try {
        watched = await watch(context, signal, startedMs + deliveryTimeoutMs, (message, atMs) => {
          const mine = isHawkMessage(context, message);

          if (mine) {
            foundAtMs ??= atMs;
          }

          return mine;
        }, () => foundAtMs !== undefined);
      } catch (error) {
        telegram.found = false;
        telegram.lastReadOk = false;

        throw error;
      }

      if (foundAtMs !== undefined) {
        telegram.found = true;
        telegram.lastReadOk = true;
        telegram.latencyMs = Math.round(foundAtMs - (state.acceptedAtMs ?? startedMs));

        return { status: 'ok',
          details: { latencyMs: telegram.latencyMs } };
      }

      telegram.found = false;
      telegram.lastReadOk = watched.lastReadOk ?? false;

      const details = { lastReadOk: telegram.lastReadOk,
        polls: telegram.polls,
        unmatched: telegram.unmatched };

      if (watched.lastReadOk === true) {
        return { status: 'failed',
          error: new CheckError('telegram_not_delivered', { detail: `no message of ${senderUsername} for this run arrived within ${formatDuration(deliveryTimeoutMs)}` }),
          details };
      }

      return { status: 'failed',
        error: readFailure(watched),
        details };
    },
  };
}

/**
 * Tells whether the probe is needed: Hawk formed the notification, the chat was read without trouble and still nothing came.
 * @param context Context the earlier stages filled.
 * @returns True when the probe should run.
 */
function probeIsNeeded(context: TelegramContext): boolean {
  const { notification, telegram } = context;

  return !notification.warmup
    && telegram.formedOk === true
    && (notification.arrivals?.telegram.length ?? 0) > 0
    && telegram.found === false
    && telegram.lastReadOk === true;
}

/**
 * Stage `telegram_probe`: when the notification of Hawk did not arrive, sends a message through @codex_bot itself and waits for it, which tells the Hawk worker from the rest of the chain.
 * @param timeoutMs Time limit of the stage: one send, the wait and one read after it.
 * @returns Stage spec.
 */
export function telegramProbeStage(timeoutMs: number): StageSpec<TelegramContext> {
  return {
    name: 'telegram_probe',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, config, state, telegram } = context;
      const { notifyUrl, probeTimeoutMs } = config.scenarios.telegramDelivery;

      if (!probeIsNeeded(context)) {
        return { status: 'skipped' };
      }

      if (notifyUrl === undefined) {
        throw new CheckError('monitor_internal', { detail: 'the probe needs TELEGRAM_NOTIFY_URL' });
      }

      const text = probeText(context);
      const probe: ProbeState = { sentAt: clock.wallTime().toISOString() };

      telegram.probe = probe;

      const sentMs = clock.monotonicMs();

      await context.sendProbe(notifyUrl, text, { httpTimeoutMs: config.httpTimeoutMs,
        clock }, signal);

      let arrivedAtMs: number | undefined;
      let hawkAtMs: number | undefined;
      const watched = await watch(context, signal, clock.monotonicMs() + probeTimeoutMs, (message, atMs) => {
        if (isHawkMessage(context, message)) {
          hawkAtMs ??= atMs;

          return true;
        }

        if (message.fromIsBot && firstLineOf(message.text) === text) {
          arrivedAtMs ??= atMs;

          return true;
        }

        return false;
      }, () => arrivedAtMs !== undefined || hawkAtMs !== undefined);

      probe.readsOk = watched.lastReadOk === true;

      if (hawkAtMs !== undefined) {
        probe.lateHawkMessageMs = Math.round(hawkAtMs - (state.acceptedAtMs ?? sentMs));
      }

      if (arrivedAtMs !== undefined) {
        probe.arrivedMs = Math.round(arrivedAtMs - sentMs);
      }

      const details = { ...probe };

      if (hawkAtMs !== undefined || arrivedAtMs !== undefined) {
        return { status: 'ok',
          details };
      }

      if (watched.lastReadOk === true) {
        return { status: 'failed',
          error: new CheckError('telegram_bot_unavailable', {}, { message: `The probe message sent through @codex_bot did not arrive in the chat within ${formatDuration(probeTimeoutMs)}` }),
          details };
      }

      return { status: 'failed',
        error: readFailure(watched),
        details };
    },
  };
}
