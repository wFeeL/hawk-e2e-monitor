import { describe, expect, it } from 'vitest';
import type { StageName, StageResult } from '../../../src/engine/result.js';
import type { Arrival, Arrivals } from '../../../src/receiver/server.js';
import type { ScenarioState } from '../../../src/scenarios/send-and-receive/stages.js';
import type { NotificationState } from '../../../src/scenarios/check-notification/stages.js';
import { decideNotificationVerdict } from '../../../src/scenarios/check-notification/verdict.js';

const PROJECT = 'p1';
const TITLE = 'title-1';
const EVENT_ID = 'event-1';
const ACCEPTED_AT = 1000;
const GOOD_HEADERS = Object.fromEntries([
  ['user-agent', 'Hawk-Webhook/1.0'],
  ['x-hawk-notification', 'event'],
]);

/** Parts of a webhook body that a test may change. */
interface WebhookChanges {
  /** Kind of the notification. */
  type?: string;
  /** Project id. */
  projectId?: string;
  /** Event id. */
  id?: string;
}

/**
 * Builds a webhook body like Hawk's.
 * @param changes Parts that replace the good ones.
 * @returns JSON text.
 */
function webhookBody(changes: WebhookChanges = {}): string {
  return JSON.stringify({ type: changes.type ?? 'event',
    payload: { project: { id: changes.projectId ?? PROJECT },
      events: [{ event: { id: changes.id ?? EVENT_ID,
        title: TITLE } }] } });
}

/**
 * Builds a loop message like Hawk's.
 * @param title Title in the message.
 * @returns Text with the title and the link.
 */
function loopBody(title = TITLE): string {
  return `**${title}**\n[Details](https://garage/project/${PROJECT}/event/${EVENT_ID}/)`;
}

/**
 * Builds a recorded stage.
 * @param name Stage that ran.
 * @param status How it ended.
 * @param extra Fields to add.
 * @returns Stage result.
 */
function stage(name: StageName, status: StageResult['status'] = 'ok', extra: Partial<StageResult> = {}): StageResult {
  return { name,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    ...extra };
}

/**
 * Builds one POST.
 * @param channel Channel the POST came through.
 * @param atMs Monotonic time of arrival.
 * @param body Body text; a fitting one by default.
 * @param headers Request headers of a webhook; the right ones by default.
 * @returns One arrival record.
 */
function arrival(channel: 'webhook' | 'loop', atMs: number, body?: string, headers: Record<string, string> = GOOD_HEADERS): Arrival {
  const text = body ?? (channel === 'webhook' ? webhookBody() : loopBody());

  return { channel,
    atMs,
    headers: channel === 'webhook' ? headers : {},
    rawBody: text };
}

/**
 * Builds the counts a receiver would return.
 * @param webhook POSTs of the webhook channel.
 * @param loop POSTs of the loop channel.
 * @param unmatched POSTs that fit no run.
 * @returns Receiver counts with those POSTs.
 */
function arrivals(webhook: Arrival[], loop: Arrival[], unmatched = 0): Arrivals {
  return { webhook,
    loop,
    unmatched };
}

const BOTH = arrivals([arrival('webhook', 1300)], [arrival('loop', 1500)]);

/**
 * Builds the stages of a healthy run, with changes.
 * @param changes Stages that take the place of the healthy ones with the same name.
 * @returns Stages in run order.
 */
function stages(...changes: StageResult[]): StageResult[] {
  const names: StageName[] = ['collector_availability', 'api_availability', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'event_repeated', 'cleanup'];

  return names.map(name => changes.find(change => change.name === name) ?? stage(name));
}

const STATE: ScenarioState = {
  sendMayHaveReached: false,
  acceptedAtMs: ACCEPTED_AT,
  event: { originalEventId: EVENT_ID,
    groupHash: 'g',
    totalCount: 1,
    catcherType: 'errors/nodejs',
    title: TITLE,
    context: null },
};

/**
 * Builds the notification state of a run.
 * @param stageArrivals What the receiver had when the wait ended.
 * @param finalArrivals What it had after cleanup.
 * @param extra Further fields of the state.
 * @returns State.
 */
function notification(stageArrivals: Arrivals | undefined, finalArrivals: Arrivals | undefined, extra: Partial<NotificationState> = {}): NotificationState {
  return { warmup: false,
    ...stageArrivals === undefined ? {} : { arrivals: stageArrivals },
    ...finalArrivals === undefined ? {} : { finalArrivals },
    ...extra };
}

describe('decideNotificationVerdict', () => {
  it('passes a healthy run and reports latency and the event id', () => {
    const result = decideNotificationVerdict(stages(), STATE, notification(BOTH, BOTH), PROJECT);

    expect(result.verdict).toEqual({ status: 'ok' });
    expect(result.warnings).toEqual([]);
    expect(result.notification).toEqual({ webhook: { latencyMs: 300,
      eventId: EVENT_ID },
    loop: { latencyMs: 500 },
    unmatched: 0 });
  });

  it('collects warnings of the stages in order, one text and a list', () => {
    const result = decideNotificationVerdict(stages(stage('api_availability', 'ok', { details: { warning: 'quota' } }), stage('notification_formed', 'ok', { details: { warnings: ['one', 'two'] } })), STATE, notification(BOTH, BOTH), PROJECT);

    expect(result.warnings).toEqual(['quota', 'one', 'two']);
  });

  it('has no notification section when nothing was read', () => {
    expect(decideNotificationVerdict(stages(), STATE, notification(undefined, undefined), PROJECT).notification).toBeUndefined();
  });

  describe('collector blame', () => {
    const uncertain = stage('collector_accept', 'uncertain', { errorClass: 'collector_unavailable',
      message: 'no answer' });
    const notFound = stage('event_visible', 'failed', { errorClass: 'event_not_found',
      message: 'Event not found',
      details: { waitedMs: 500 } });

    it('goes to the collector without a notification, as in send-and-receive-event', () => {
      const result = decideNotificationVerdict(stages(uncertain, notFound), { ...STATE,
        event: undefined }, notification(arrivals([], []), arrivals([], [])), PROJECT);

      expect(result.verdict).toMatchObject({ status: 'failed',
        failedStage: 'collector_accept' });
    });

    it('stays on event_visible with a note when a notification arrived', () => {
      const result = decideNotificationVerdict(stages(uncertain, notFound), { ...STATE,
        event: undefined }, notification(arrivals([arrival('webhook', 1300)], []), arrivals([arrival('webhook', 1300)], [])), PROJECT);

      expect(result.verdict.status).toBe('failed');
      expect(result.verdict.failedStage).toBe('event_visible');
      expect(result.verdict.error?.errorClass).toBe('event_not_found');
      expect(result.verdict.error?.message).toBe('Event not found; a notification for this event arrived, so the collector accepted it');
    });

    it('stays on event_visible even when the arrived notification was wrong', () => {
      const wrong = arrivals([arrival('webhook', 1300, 'junk')], []);
      const result = decideNotificationVerdict(stages(uncertain, notFound, stage('notification_formed', 'failed', { errorClass: 'notification_mismatch',
        message: 'bad' })), { ...STATE,
        event: undefined }, notification(wrong, wrong), PROJECT);

      expect(result.verdict.failedStage).toBe('event_visible');
    });
  });

  it('reports the failure of a stage as it is', () => {
    const result = decideNotificationVerdict(stages(stage('notification_formed', 'failed', { errorClass: 'notification_timeout',
      message: 'Neither channel arrived' })), STATE, notification(arrivals([], []), arrivals([], [])), PROJECT);

    expect(result.verdict).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed' });
    expect(result.verdict.error?.errorClass).toBe('notification_timeout');
  });

  it('fails with duplicate_event of send-and-receive-event before it looks at the notifications', () => {
    const late = stage('cleanup', 'ok', { details: { lateTotalCount: 2 } });
    const twice = arrivals([arrival('webhook', 1300), arrival('webhook', 1400)], [arrival('loop', 1500)]);
    const result = decideNotificationVerdict(stages(late), STATE, notification(BOTH, twice), PROJECT);

    expect(result.verdict.error?.errorClass).toBe('duplicate_event');
  });

  describe('against the event', () => {
    it('webhook with another event id is notification_mismatch on notification_formed', () => {
      const wrong = arrivals([arrival('webhook', 1300, webhookBody({ id: 'other' }))], [arrival('loop', 1500)]);
      const result = decideNotificationVerdict(stages(), STATE, notification(wrong, wrong), PROJECT);

      expect(result.verdict).toMatchObject({ status: 'failed',
        failedStage: 'notification_formed' });
      expect(result.verdict.error?.errorClass).toBe('notification_mismatch');
      expect(result.verdict.error?.message).toContain('webhook.event.id');
    });

    it('a loop link to another event is notification_mismatch', () => {
      const wrong = arrivals([arrival('webhook', 1300)], [arrival('loop', 1500, '[Details](https://garage/project/p1/event/other/)')]);
      const result = decideNotificationVerdict(stages(), STATE, notification(wrong, wrong), PROJECT);

      expect(result.verdict.error?.message).toContain('loop.link');
    });

    it('is not checked without the event', () => {
      const wrong = arrivals([arrival('webhook', 1300, 'junk')], []);
      const result = decideNotificationVerdict(stages(), { ...STATE,
        event: undefined }, notification(wrong, wrong), PROJECT);

      expect(result.verdict.status).toBe('ok');
    });

    it('is not checked when notification_formed was skipped', () => {
      const wrong = arrivals([arrival('webhook', 1300, 'junk')], []);
      const result = decideNotificationVerdict(stages(stage('notification_formed', 'skipped')), STATE, notification(undefined, wrong, { warmup: true }), PROJECT);

      expect(result.verdict.status).toBe('ok');
    });
  });

  describe('repeats', () => {
    it.each(['webhook', 'loop'] as const)('two %s posts are duplicate_notification', (channel) => {
      const twice = channel === 'webhook'
        ? arrivals([arrival('webhook', 1300), arrival('webhook', 1700)], [arrival('loop', 1500)])
        : arrivals([arrival('webhook', 1300)], [arrival('loop', 1500), arrival('loop', 1700)]);
      const result = decideNotificationVerdict(stages(), STATE, notification(BOTH, twice), PROJECT);

      expect(result.verdict).toMatchObject({ status: 'failed',
        failedStage: 'notification_formed' });
      expect(result.verdict.error?.errorClass).toBe('duplicate_notification');
      expect(result.verdict.error?.message).toBe(`The ${channel} notification arrived 2 times`);
    });

    it('a mismatch wins over a repeat', () => {
      const both = arrivals([arrival('webhook', 1300, webhookBody({ id: 'other' })), arrival('webhook', 1700)], [arrival('loop', 1500)]);
      const result = decideNotificationVerdict(stages(), STATE, notification(both, both), PROJECT);

      expect(result.verdict.error?.errorClass).toBe('notification_mismatch');
    });

    it('a failed cleanup is reported before a repeat', () => {
      const twice = arrivals([arrival('webhook', 1300), arrival('webhook', 1400)], [arrival('loop', 1500)]);
      const result = decideNotificationVerdict(stages(stage('cleanup', 'failed', { errorClass: 'cleanup_failed',
        message: 'x' })), STATE, notification(BOTH, twice), PROJECT);

      expect(result.verdict.failedStage).toBe('cleanup');
    });
  });

  describe('a channel that came late', () => {
    const formed = stage('notification_formed', 'ok', { details: { warning: 'Only the webhook notification arrived; the loop sender did not deliver within 200 ms' } });
    const early = arrivals([arrival('webhook', 1300)], []);

    it('replaces the warning and reports its latency', () => {
      const result = decideNotificationVerdict(stages(formed), STATE, notification(early, arrivals([arrival('webhook', 1300)], [arrival('loop', 1800)])), PROJECT);

      expect(result.verdict.status).toBe('ok');
      expect(result.warnings).toEqual(['The loop notification arrived after the pair wait, 800 ms after the send']);
      expect(result.notification?.loop).toEqual({ latencyMs: 800 });
    });

    it('keeps the warning when the channel never came', () => {
      const result = decideNotificationVerdict(stages(formed), STATE, notification(early, early), PROJECT);

      expect(result.warnings).toEqual([formed.details?.warning]);
      expect(result.notification?.loop).toBeUndefined();
    });

    it.each([
      ['webhook.user-agent', arrival('webhook', 1800, undefined, Object.fromEntries([['user-agent', 'curl/8'], ['x-hawk-notification', 'event']]))],
      ['webhook.x-hawk-notification', arrival('webhook', 1800, undefined, Object.fromEntries([['user-agent', 'Hawk-Webhook/1.0']]))],
      ['webhook.project.id', arrival('webhook', 1800, webhookBody({ projectId: 'other' }))],
      ['webhook.type', arrival('webhook', 1800, webhookBody({ type: 'other' }))],
      ['webhook.body', arrival('webhook', 1800, 'not json')],
    ])('a webhook that came late gets the full check: %s', (field, late) => {
      const onlyLoop = arrivals([], [arrival('loop', 1300)]);
      const warned = stage('notification_formed', 'ok', { details: { warning: 'Only the loop notification arrived; the webhook sender did not deliver within 200 ms' } });
      const result = decideNotificationVerdict(stages(warned), STATE, notification(onlyLoop, arrivals([late], onlyLoop.loop)), PROJECT);

      expect(result.verdict).toMatchObject({ status: 'failed',
        failedStage: 'notification_formed' });
      expect(result.verdict.error?.errorClass).toBe('notification_mismatch');
      expect(result.verdict.error?.message).toContain(field);
    });

    it('a loop that came late without the title is notification_mismatch', () => {
      const result = decideNotificationVerdict(stages(formed), STATE, notification(early, arrivals(early.webhook, [arrival('loop', 1800, loopBody('another title'))])), PROJECT);

      expect(result.verdict.error?.errorClass).toBe('notification_mismatch');
      expect(result.verdict.error?.message).toContain('loop.title');
    });

    it('a late channel that fits is accepted', () => {
      const result = decideNotificationVerdict(stages(formed), STATE, notification(early, arrivals(early.webhook, [arrival('loop', 1800)])), PROJECT);

      expect(result.verdict.status).toBe('ok');
    });

    it('is a repeat when it came twice', () => {
      const result = decideNotificationVerdict(stages(formed), STATE, notification(early, arrivals([arrival('webhook', 1300)], [arrival('loop', 1800), arrival('loop', 1900)])), PROJECT);

      expect(result.verdict.error?.errorClass).toBe('duplicate_notification');
    });
  });

  it('reports unmatched posts from the final counts', () => {
    const result = decideNotificationVerdict(stages(), STATE, notification(BOTH, arrivals(BOTH.webhook, BOTH.loop, 2)), PROJECT);

    expect(result.notification?.unmatched).toBe(2);
  });
});
