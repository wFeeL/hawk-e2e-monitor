import { formatDuration } from '../../time/format.js';
import type { RunNotification, StageResult } from '../../engine/result.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { Arrivals } from '../../receiver/server.js';
import type { NotificationChannel } from '../../notifications/types.js';
import type { ScenarioState } from '../send-and-receive/stages.js';
import { decideVerdict } from '../shared/verdict.js';
import type { Verdict } from '../shared/verdict.js';
import { stageWarnings } from '../run-steps.js';
import { checkLoop, checkNotificationAgainstEvent, checkWebhook } from './stages.js';
import type { NotificationState } from './stages.js';

const CHANNELS: readonly NotificationChannel[] = ['webhook', 'loop'];
const COLLECTOR_NOTE = '; a notification for this event arrived, so the collector accepted it';
const ONLY_PREFIX = 'Only the ';

/** The event of a webhook body. */
interface WebhookIdsEvent {
  /** Id of the event. */
  id?: unknown;
}

/** One entry of the events of a webhook payload. */
interface WebhookIdsItem {
  /** The event. */
  event?: WebhookIdsEvent;
}

/** The events of a webhook payload. */
interface WebhookIdsPayload {
  /** Events of the notification. */
  events?: WebhookIdsItem[];
}

/** The part of a webhook body that names the event. */
interface WebhookIds {
  /** Payload of the notification. */
  payload?: WebhookIdsPayload;
}

/** The outcome of a `check-notification` run. */
export interface NotificationVerdict {
  /** Pass or fail with the stage and error to blame. */
  verdict: Verdict;
  /** Non-fatal remarks of all stages, with the late-arrival correction applied. */
  warnings: string[];
  /** What was learned about the notifications; absent when none were read. */
  notification?: RunNotification;
}

/**
 * Tells whether any notification of the run arrived while the stage waited.
 * @param arrivals Arrivals at the end of the wait.
 * @returns True when at least one POST was bound to the run.
 */
function anyArrived(arrivals: Arrivals | undefined): boolean {
  return arrivals !== undefined && CHANNELS.some(channel => arrivals[channel].length > 0);
}

/**
 * Builds the warnings, replacing «only one channel arrived» by a late-arrival note when the other came after cleanup.
 * @param stages Recorded stages.
 * @param state Run state with the acceptance time.
 * @param notification Arrivals of the stage and after cleanup.
 * @returns Texts of the warnings.
 */
function buildWarnings(stages: readonly StageResult[], state: ScenarioState, notification: NotificationState): string[] {
  const { arrivals, finalArrivals } = notification;
  const warnings = stageWarnings(stages);

  if (arrivals === undefined || finalArrivals === undefined || state.acceptedAtMs === undefined) {
    return warnings;
  }

  for (const channel of CHANNELS) {
    const [late] = finalArrivals[channel];
    const index = warnings.findIndex(text => text.startsWith(ONLY_PREFIX));

    if (arrivals[channel].length === 0 && finalArrivals[channel].length === 1 && late !== undefined && index >= 0) {
      warnings[index] = `The ${channel} notification arrived after the pair wait, ${formatDuration(late.atMs - state.acceptedAtMs)} after the send`;
    }
  }

  return warnings;
}

/**
 * Summarises the arrivals for the result.
 * @param state Run state with the acceptance time.
 * @param finalArrivals Counts after cleanup.
 * @returns Latency per channel, the webhook's event id and the unmatched count.
 */
function summarize(state: ScenarioState, finalArrivals: Arrivals): RunNotification {
  const summary: RunNotification = { unmatched: finalArrivals.unmatched };
  const [webhook] = finalArrivals.webhook;
  const [loop] = finalArrivals.loop;
  const accepted = state.acceptedAtMs;
  const [threshold] = finalArrivals.threshold;
  const repeated = state.repeatAcceptedAtMs;

  if (webhook !== undefined && accepted !== undefined) {
    summary.webhook = { latencyMs: Math.round(webhook.atMs - accepted) };

    try {
      const id = (JSON.parse(webhook.rawBody) as WebhookIds).payload?.events?.[0]?.event?.id;

      if (typeof id === 'string') {
        summary.webhook.eventId = id;
      }
    } catch {
      // A body that is not JSON has no event id; the stage already reported it.
    }
  }

  if (loop !== undefined && accepted !== undefined) {
    summary.loop = { latencyMs: Math.round(loop.atMs - accepted) };
  }

  if (threshold !== undefined && repeated !== undefined) {
    summary.threshold = { latencyMs: Math.round(threshold.atMs - repeated) };
  }

  return summary;
}

/**
 * Runs the checks of the stage on a channel that came after the stage had stopped waiting.
 * @param notification Arrivals of the stage and after cleanup.
 * @param title Title that was sent.
 * @param projectId Project of the monitor.
 * @returns The first difference, webhook before loop, or undefined.
 */
function lateMismatch(notification: NotificationState, title: string, projectId: string): CheckError | undefined {
  const { arrivals, finalArrivals } = notification;
  const [webhook] = arrivals?.webhook.length === 0 ? finalArrivals?.webhook ?? [] : [];
  const [loop] = arrivals?.loop.length === 0 ? finalArrivals?.loop ?? [] : [];

  return (webhook === undefined ? undefined : checkWebhook(webhook, title, projectId))
    ?? (loop === undefined ? undefined : checkLoop(loop, title));
}

/**
 * Decides the outcome of a `check-notification` run on top of the `send-and-receive-event` verdict.
 * A notification proves the collector took the event, so it keeps the blame off the collector.
 * @param stages Recorded stages, cleanup last.
 * @param state Run state of the scenario.
 * @param notification State of the notification stages.
 * @param projectId Project of the monitor, for the link in the loop message.
 * @param repeat Whether the run sent the event a second time; without it no threshold notification may come.
 * @returns Verdict, warnings and the notification summary.
 */
export function decideNotificationVerdict(stages: readonly StageResult[], state: ScenarioState, notification: NotificationState, projectId: string, repeat: boolean): NotificationVerdict {
  const rest = {
    warnings: buildWarnings(stages, state, notification),
    ...notification.finalArrivals === undefined ? {} : { notification: summarize(state, notification.finalArrivals) },
  };
  const failed = stages.find(stage => stage.name !== 'cleanup' && stage.status === 'failed');
  const accept = stages.find(stage => stage.name === 'collector_accept');

  if (failed?.name === 'event_visible' && failed.errorClass === 'event_not_found' && accept?.status === 'uncertain' && anyArrived(notification.arrivals)) {
    return { verdict: { status: 'failed',
      failedStage: 'event_visible',
      error: new CheckError('event_not_found', {}, { message: `${failed.message ?? 'The event was not found'}${COLLECTOR_NOTE}` }) },
    ...rest };
  }

  const base = decideVerdict(stages, state);
  const formed = stages.find(stage => stage.name === 'notification_formed');

  if (base.status === 'failed' || formed?.status !== 'ok' || notification.finalArrivals === undefined) {
    return { verdict: base,
      ...rest };
  }

  const { finalArrivals } = notification;
  const mismatch = state.event === undefined ? undefined : lateMismatch(notification, state.event.title, projectId) ?? checkNotificationAgainstEvent(finalArrivals, state.event, projectId);

  if (mismatch) {
    return { verdict: { status: 'failed',
      failedStage: 'notification_formed',
      error: mismatch },
    ...rest };
  }

  for (const channel of CHANNELS) {
    const count = finalArrivals[channel].length;

    if (count > 1) {
      return { verdict: { status: 'failed',
        failedStage: 'notification_formed',
        error: new CheckError('duplicate_notification', { channel,
          count }) },
      ...rest };
    }
  }

  // The threshold is 2, so a POST in a run that sent one event means the rule fired on the first.
  if (!repeat && finalArrivals.threshold.length > 0) {
    return { verdict: { status: 'failed',
      failedStage: 'threshold_formed',
      error: new CheckError('threshold_early', { detail: 'a threshold POST arrived in a run that sent no repeat' }) },
    ...rest };
  }

  const thresholdStage = stages.find(stage => stage.name === 'threshold_formed');
  const thresholdCount = finalArrivals.threshold.length;

  if (thresholdStage?.status === 'ok' && thresholdCount > 1) {
    return { verdict: { status: 'failed',
      failedStage: 'threshold_formed',
      error: new CheckError('duplicate_notification', { channel: 'threshold',
        count: thresholdCount }) },
    ...rest };
  }

  return { verdict: base,
    ...rest };
}
