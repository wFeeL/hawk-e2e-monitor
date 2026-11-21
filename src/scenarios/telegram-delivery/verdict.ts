import type { RunNotification, RunTelegram, StageName, StageResult } from '../../engine/result.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { ErrorClass } from '../../errors/taxonomy.js';
import { arrivalCount } from '../../receiver/server.js';
import type { Arrivals } from '../../receiver/server.js';
import { checkNotificationAgainstEvent } from '../check-notification/stages.js';
import type { NotificationState } from '../check-notification/stages.js';
import { stageWarnings } from '../run-steps.js';
import type { ScenarioState } from '../shared/context.js';
import { decideHead, decideTail, errorOf } from '../shared/verdict.js';
import type { Verdict } from '../shared/verdict.js';
import type { TelegramState } from './stages.js';

// The stages that come before the group and `event_visible`: a failure there is not about Telegram delivery.
const BASE_STAGES: readonly StageName[] = ['collector_availability', 'api_availability', 'telegram_ready', 'notification_setup', 'collector_accept', 'event_visible'];
const TELEGRAM_STAGES: readonly StageName[] = ['notification_formed', 'telegram_delivered', 'telegram_probe'];
const ENDING_CLASSES: readonly ErrorClass[] = ['telegram_conflict', 'telegram_auth_failed', 'telegram_bot_misconfigured'];

/** The outcome of a `telegram-delivery` run. */
export interface TelegramVerdict {
  /** Pass or fail with the stage and error to blame. */
  verdict: Verdict;
  /** Non-fatal remarks of all stages. */
  warnings: string[];
  /** What was learned about the webhook of rule T; absent when none was read. */
  notification?: RunNotification;
  /** What was learned from the chat; absent when nothing was read. */
  telegram?: RunTelegram;
}

/**
 * Builds the `telegram` field of the result.
 * @param telegram State of the Telegram stages.
 * @returns Latency, the count of other messages and the probe.
 */
function telegramField(telegram: TelegramState): RunTelegram {
  const { probe } = telegram;

  return { ...telegram.latencyMs === undefined ? {} : { latencyMs: telegram.latencyMs },
    unmatched: telegram.unmatched,
    ...probe === undefined
      ? {}
      : { probe: { sentAt: probe.sentAt,
          ...probe.arrivedMs === undefined ? {} : { arrivedMs: probe.arrivedMs },
          ...probe.lateHawkMessageMs === undefined ? {} : { lateHawkMessageMs: probe.lateHawkMessageMs } } } };
}

/**
 * Summarises the webhook of rule T.
 * @param final Counts after cleanup.
 * @param acceptedAtMs Monotonic time of the collector's answer.
 * @returns Latency of the first POST and the unmatched count.
 */
function notificationField(final: Arrivals, acceptedAtMs: number | undefined): RunNotification {
  const [first] = final.telegram;

  return { unmatched: final.unmatched,
    ...first === undefined || acceptedAtMs === undefined ? {} : { telegram: { latencyMs: Math.round(first.atMs - acceptedAtMs) } } };
}

/**
 * Builds a failed verdict.
 * @param failedStage Stage the failure is blamed on.
 * @param error Class and text the run fails with.
 * @returns Verdict with status failed that names the stage and carries the error.
 */
function failedVerdict(failedStage: StageName, error: CheckError): Verdict {
  return { status: 'failed',
    failedStage,
    error };
}

/**
 * Judges a run that is still ok: the cleanup, the late count of the event, the event the webhook names and the number of webhooks.
 * @param stages Recorded stages.
 * @param state Run state with the found event.
 * @param notification Notification state with the counts after cleanup.
 * @param projectId Id of the monitored project, which the webhook must name.
 * @returns Ok, or the first failure of these checks.
 */
function decideRest(stages: readonly StageResult[], state: ScenarioState, notification: NotificationState, projectId: string): Verdict {
  const tail = decideTail(stages);
  const { finalArrivals } = notification;

  if (tail.status === 'failed' || finalArrivals === undefined || stages.find(stage => stage.name === 'notification_formed')?.status !== 'ok') {
    return tail;
  }

  const mismatch = state.event === undefined
    ? undefined
    : checkNotificationAgainstEvent({ ...finalArrivals,
        webhook: finalArrivals.telegram,
        loop: [] }, state.event, projectId);

  if (mismatch) {
    return failedVerdict('notification_formed', mismatch);
  }

  const count = arrivalCount(finalArrivals, 'telegram');

  return count > 1
    ? failedVerdict('notification_formed', new CheckError('duplicate_notification', { channel: 'telegram',
        count }))
    : tail;
}

/**
 * Decides the verdict when the message of Hawk did not come and the webhook of rule T did: the probe tells the worker from the rest of the chain.
 * @param stages Recorded stages.
 * @param telegram State of the Telegram stages.
 * @returns The verdict, or undefined when the probe left no usable outcome.
 */
function decideByProbe(stages: readonly StageResult[], telegram: TelegramState): Verdict | undefined {
  const probeStage = stages.find(stage => stage.name === 'telegram_probe');
  const { probe } = telegram;

  if (probe?.lateHawkMessageMs !== undefined) {
    return failedVerdict('telegram_delivered', new CheckError('telegram_not_delivered', {}, { message: `The Telegram notification arrived after ${String(probe.lateHawkMessageMs)} ms, later than TELEGRAM_DELIVERY_TIMEOUT_MS` }));
  }

  if (probe?.arrivedMs !== undefined) {
    return failedVerdict('telegram_delivered', new CheckError('telegram_not_delivered', {}, { message: `Hawk formed the notification but its Telegram worker did not deliver it; a direct @codex_bot message arrived in ${String(probe.arrivedMs)} ms` }));
  }

  return probeStage?.status === 'failed' ? failedVerdict('telegram_probe', errorOf(probeStage)) : undefined;
}

/**
 * Decides the outcome of a `telegram-delivery` run on top of the `send-and-receive-event` verdict.
 * The order: a failure before the group; a Telegram stage that ended on a class of its own; the message found; the webhook failed;
 * the chat unreadable; the probe; the rule cache warmup; any other failed Telegram stage. Only a found message or the warmup gives `ok`.
 * @param stages Recorded stages, cleanup last.
 * @param state Run state of the scenario.
 * @param notification State of the notification stages.
 * @param telegram State of the Telegram stages.
 * @param projectId Project of the monitor.
 * @returns Verdict, warnings and the summaries of the webhook and the chat.
 */
export function decideTelegramVerdict(stages: readonly StageResult[], state: ScenarioState, notification: NotificationState, telegram: TelegramState, projectId: string): TelegramVerdict {
  const rest = {
    warnings: stageWarnings(stages),
    ...notification.finalArrivals === undefined ? {} : { notification: notificationField(notification.finalArrivals, state.acceptedAtMs) },
    ...telegram.found === undefined && telegram.probe === undefined ? {} : { telegram: telegramField(telegram) },
  };
  const stageOf = (name: StageName): StageResult | undefined => stages.find(stage => stage.name === name);
  const decided = (verdict: Verdict): TelegramVerdict => ({ verdict,
    ...rest });
  const base = decideHead(stages.filter(stage => BASE_STAGES.includes(stage.name)));

  if (base) {
    return decided(base);
  }

  const formed = stageOf('notification_formed');
  const delivered = stageOf('telegram_delivered');
  const probe = stageOf('telegram_probe');

  for (const stage of [delivered, probe]) {
    if (stage?.status === 'failed' && stage.errorClass !== undefined && ENDING_CLASSES.includes(stage.errorClass)) {
      return decided(failedVerdict(stage.name, errorOf(stage)));
    }
  }

  if (delivered?.status === 'ok') {
    return decided(decideRest(stages, state, notification, projectId));
  }

  if (delivered?.status === 'failed' && formed?.status === 'failed') {
    return decided(failedVerdict('notification_formed', errorOf(formed)));
  }

  if (delivered?.status === 'failed' && formed?.status === 'ok') {
    if (delivered.errorClass === 'telegram_api_unavailable') {
      return decided(failedVerdict('telegram_delivered', errorOf(delivered)));
    }

    const byProbe = delivered.errorClass === 'telegram_not_delivered' && probe?.status !== 'skipped' ? decideByProbe(stages, telegram) : undefined;

    if (byProbe) {
      return decided(byProbe);
    }
  }

  if (formed?.status === 'skipped' && formed.details?.reason === 'rule_cache_warmup') {
    return decided(decideRest(stages, state, notification, projectId));
  }

  const firstFailed = TELEGRAM_STAGES.map(stageOf).find(stage => stage?.status === 'failed');

  return decided(firstFailed
    ? failedVerdict(firstFailed.name, errorOf(firstFailed))
    : failedVerdict('telegram_delivered', new CheckError('monitor_internal', {}, { message: 'The Telegram check ended without a verdict' })));
}
