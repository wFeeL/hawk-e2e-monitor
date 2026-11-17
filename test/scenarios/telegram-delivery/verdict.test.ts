import { describe, expect, it } from 'vitest';
import type { StageName, StageResult } from '../../../src/engine/result.js';
import type { ErrorClass } from '../../../src/errors/taxonomy.js';
import { CULPRIT_OF } from '../../../src/errors/taxonomy.js';
import type { Arrival, Arrivals } from '../../../src/receiver/server.js';
import type { NotificationState } from '../../../src/scenarios/check-notification/stages.js';
import type { ScenarioState } from '../../../src/scenarios/shared/context.js';
import type { TelegramState } from '../../../src/scenarios/telegram-delivery/stages.js';
import { decideTelegramVerdict } from '../../../src/scenarios/telegram-delivery/verdict.js';

const PROJECT = 'p1';
const TITLE = 'title-1';
const EVENT_ID = 'event-1';
const ACCEPTED_AT = 1000;
const GOOD_HEADERS = Object.fromEntries([
  ['user-agent', 'Hawk-Webhook/1.0'],
  ['x-hawk-notification', 'event'],
]);

/**
 * Builds a recorded stage; a failed one gets the culprit of its class.
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
    ...extra.errorClass === undefined ? {} : { culprit: CULPRIT_OF[extra.errorClass] },
    ...extra };
}

/**
 * Builds a failed stage.
 * @param name Stage that ran.
 * @param errorClass Class of the failure.
 * @param extra Fields to add.
 * @returns Stage result.
 */
function failed(name: StageName, errorClass: ErrorClass, extra: Partial<StageResult> = {}): StageResult {
  return stage(name, 'failed', { errorClass,
    message: `text of ${errorClass}`,
    ...extra });
}

/**
 * Builds the stages of a healthy run with changes.
 * @param changes Stages that take the place of the healthy ones with the same name.
 * @returns Stages in run order; the probe is skipped unless a change says otherwise.
 */
function stages(...changes: StageResult[]): StageResult[] {
  const names: StageName[] = ['collector_availability', 'api_availability', 'telegram_ready', 'notification_setup', 'collector_accept', 'event_visible',
    'notification_formed', 'telegram_delivered', 'telegram_probe', 'cleanup'];

  return names.map(name => changes.find(change => change.name === name) ?? stage(name, name === 'telegram_probe' ? 'skipped' : 'ok'));
}

/**
 * Builds the webhook arrival of rule T.
 * @param eventId Event id in the body.
 * @returns One arrival.
 */
function webhook(eventId = EVENT_ID): Arrival {
  return { channel: 'telegram',
    atMs: 1300,
    headers: GOOD_HEADERS,
    rawBody: JSON.stringify({ type: 'event',
      payload: { project: { id: PROJECT },
        events: [{ event: { id: eventId,
          title: TITLE } }] } }) };
}

/**
 * Builds receiver counts.
 * @param telegram POSTs of the Telegram rule.
 * @returns Counts with no other POSTs.
 */
function arrivals(telegram: Arrival[]): Arrivals {
  return { webhook: [],
    loop: [],
    threshold: [],
    telegram,
    unmatched: 0 };
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
 * Builds the notification state of a run whose webhook arrived.
 * @param final Counts after cleanup.
 * @param extra Fields to add.
 * @returns State.
 */
function notification(final: Arrivals | undefined = arrivals([webhook()]), extra: Partial<NotificationState> = {}): NotificationState {
  return { warmup: false,
    ...final === undefined
      ? {}
      : { arrivals: final,
          finalArrivals: final },
    ...extra };
}

/**
 * Builds the state of the Telegram stages.
 * @param extra Fields to add.
 * @returns State of a run that found the message.
 */
function telegramState(extra: Partial<TelegramState> = {}): TelegramState {
  return { offset: 5,
    polls: 3,
    unmatched: 1,
    found: true,
    lastReadOk: true,
    latencyMs: 4200,
    formedOk: true,
    ...extra };
}

/**
 * Decides with the usual state.
 * @param list Stages of the run.
 * @param state Notification state.
 * @param telegram State of the Telegram stages.
 * @returns The verdict and its extras.
 */
function decide(list: StageResult[], state: NotificationState = notification(), telegram: TelegramState = telegramState()): ReturnType<typeof decideTelegramVerdict> {
  return decideTelegramVerdict(list, STATE, state, telegram, PROJECT);
}

const NOT_DELIVERED = failed('telegram_delivered', 'telegram_not_delivered');

describe('decideTelegramVerdict', () => {
  it('rows 3: the message was found, so the run is ok', () => {
    const decided = decide(stages());

    expect(decided.verdict).toEqual({ status: 'ok' });
    expect(decided.telegram).toEqual({ latencyMs: 4200,
      unmatched: 1 });
    expect(decided.notification).toEqual({ unmatched: 0,
      telegram: { latencyMs: 300 } });
  });

  it('row 3 with a failed webhook is still ok, and the verdict leaves the degradation to the outcome', () => {
    const list = stages(failed('notification_formed', 'notification_timeout'));

    expect(decide(list, notification(arrivals([]))).verdict).toEqual({ status: 'ok' });
  });

  it('row 1: a failure before the group is the result, telegram_ready included', () => {
    expect(decide(stages(failed('api_availability', 'token_mismatch'))).verdict).toMatchObject({ status: 'failed',
      failedStage: 'api_availability' });
    expect(decide(stages(failed('telegram_ready', 'telegram_conflict'))).verdict).toMatchObject({ status: 'failed',
      failedStage: 'telegram_ready',
      error: { errorClass: 'telegram_conflict' } });
    expect(decide(stages(failed('event_visible', 'event_not_found'))).verdict).toMatchObject({ failedStage: 'event_visible' });
  });

  it('row 1 does not let a Telegram failure hide behind a base failure', () => {
    const list = stages(failed('event_visible', 'event_not_found'), NOT_DELIVERED);

    expect(decide(list).verdict).toMatchObject({ failedStage: 'event_visible' });
  });

  it('row 2: a conflict, a rejected token or a lost view in the Telegram stages names that class and stage', () => {
    for (const errorClass of ['telegram_conflict', 'telegram_auth_failed', 'telegram_bot_misconfigured'] as const) {
      expect(decide(stages(failed('telegram_delivered', errorClass)), notification(), telegramState({ found: false,
        lastReadOk: false })).verdict).toMatchObject({ status: 'failed',
        failedStage: 'telegram_delivered',
        error: { errorClass,
          culprit: 'config' } });
    }

    expect(decide(stages(NOT_DELIVERED, failed('telegram_probe', 'telegram_conflict'))).verdict).toMatchObject({ failedStage: 'telegram_probe',
      error: { errorClass: 'telegram_conflict' } });
  });

  it('row 4: no message and a failed webhook keeps the class of the webhook stage', () => {
    for (const errorClass of ['tunnel_unavailable', 'notification_mismatch', 'notification_timeout'] as const) {
      expect(decide(stages(failed('notification_formed', errorClass), NOT_DELIVERED), notification(arrivals([]))).verdict).toMatchObject({ status: 'failed',
        failedStage: 'notification_formed',
        error: { errorClass } });
    }
  });

  it('row 5: the webhook is fine and the chat could not be read is telegram_api_unavailable', () => {
    expect(decide(stages(failed('telegram_delivered', 'telegram_api_unavailable')), notification(), telegramState({ found: false,
      lastReadOk: false })).verdict).toMatchObject({ status: 'failed',
      failedStage: 'telegram_delivered',
      error: { errorClass: 'telegram_api_unavailable' } });
  });

  describe('row 6: the probe decides', () => {
    const missing = telegramState({ found: false });

    it('a message of Hawk that came during the probe wait is a late delivery', () => {
      const list = stages(NOT_DELIVERED, stage('telegram_probe'));
      const decided = decide(list, notification(), telegramState({ found: false,
        probe: { sentAt: 'x',
          lateHawkMessageMs: 130_000,
          readsOk: true } }));

      expect(decided.verdict).toMatchObject({ status: 'failed',
        failedStage: 'telegram_delivered',
        error: { errorClass: 'telegram_not_delivered',
          culprit: 'hawk',
          message: expect.stringContaining('arrived after 130000 ms, later than TELEGRAM_DELIVERY_TIMEOUT_MS') as string } });
    });

    it('a probe that arrived puts the blame on the Telegram worker of Hawk', () => {
      const decided = decide(stages(NOT_DELIVERED, stage('telegram_probe')), notification(), telegramState({ found: false,
        probe: { sentAt: 'x',
          arrivedMs: 1234,
          readsOk: true } }));

      expect(decided.verdict).toMatchObject({ failedStage: 'telegram_delivered',
        error: { errorClass: 'telegram_not_delivered',
          message: expect.stringMatching(/Telegram worker did not deliver it; a direct @codex_bot message arrived in 1234 ms/u) as string } });
    });

    it('a rejected probe is telegram_bot_unavailable and keeps the culprit of the stage', () => {
      const config = failed('telegram_probe', 'telegram_bot_unavailable', { culprit: 'config' });
      const network = failed('telegram_probe', 'telegram_bot_unavailable');

      expect(decide(stages(NOT_DELIVERED, config), notification(), missing).verdict).toMatchObject({ failedStage: 'telegram_probe',
        error: { errorClass: 'telegram_bot_unavailable',
          culprit: 'config' } });
      expect(decide(stages(NOT_DELIVERED, network), notification(), missing).verdict).toMatchObject({ failedStage: 'telegram_probe',
        error: { errorClass: 'telegram_bot_unavailable',
          culprit: 'network' } });
    });

    it('a probe that did not arrive while the reads failed is telegram_api_unavailable', () => {
      expect(decide(stages(NOT_DELIVERED, failed('telegram_probe', 'telegram_api_unavailable')), notification(), missing).verdict).toMatchObject({ failedStage: 'telegram_probe',
        error: { errorClass: 'telegram_api_unavailable' } });
    });
  });

  it('row 6a: a run in the rule cache warmup is ok', () => {
    const warmup = { reason: 'rule_cache_warmup' };
    const list = stages(stage('notification_formed', 'skipped', { details: warmup }),
      stage('telegram_delivered', 'skipped', { details: warmup }));

    expect(decide(list, notification(undefined, { warmup: true }), telegramState({ found: undefined,
      lastReadOk: undefined })).verdict).toEqual({ status: 'ok' });
  });

  it('row 6b: a Telegram stage cut by the run deadline gives its class, never ok', () => {
    const list = stages(failed('telegram_delivered', 'run_timeout'));
    const decided = decide(list, notification(), telegramState({ found: undefined }));

    expect(decided.verdict).toMatchObject({ status: 'failed',
      failedStage: 'telegram_delivered',
      error: { errorClass: 'run_timeout' } });
  });

  it('row 6b: a webhook stage that failed with no other Telegram failure names itself', () => {
    const list = stages(failed('notification_formed', 'notification_timeout'), stage('telegram_delivered', 'skipped'));

    expect(decide(list, notification(arrivals([])), telegramState({ found: undefined })).verdict).toMatchObject({ failedStage: 'notification_formed',
      error: { errorClass: 'notification_timeout' } });
  });

  it('row 6b: with no failed Telegram stage and nothing decided it is monitor_internal', () => {
    const list = stages(stage('telegram_delivered', 'skipped'));
    const decided = decide(list, notification(), telegramState({ found: undefined }));

    expect(decided.verdict).toMatchObject({ status: 'failed',
      error: { errorClass: 'monitor_internal',
        message: expect.stringContaining('The Telegram check ended without a verdict') as string } });
  });

  describe('row 7: the tail checks only on a run that is still ok', () => {
    it('a failed cleanup fails an ok run', () => {
      expect(decide(stages(failed('cleanup', 'cleanup_failed'))).verdict).toMatchObject({ failedStage: 'cleanup',
        error: { errorClass: 'cleanup_failed' } });
    });

    it('a late duplicate of the event fails an ok run', () => {
      const list = stages(stage('cleanup', 'ok', { details: { lateTotalCount: 2 } }));

      expect(decide(list).verdict).toMatchObject({ error: { errorClass: 'duplicate_event' } });
    });

    it('a second webhook of rule T is a duplicate notification of the telegram channel', () => {
      const decided = decide(stages(), notification(arrivals([webhook(), webhook()])));

      expect(decided.verdict).toMatchObject({ failedStage: 'notification_formed',
        error: { errorClass: 'duplicate_notification',
          message: expect.stringContaining('telegram') as string } });
    });

    it('a webhook that names another event is a mismatch', () => {
      const decided = decide(stages(), notification(arrivals([webhook('other-event')])));

      expect(decided.verdict).toMatchObject({ failedStage: 'notification_formed',
        error: { errorClass: 'notification_mismatch' } });
    });

    it('never replaces a Telegram failure', () => {
      const list = stages(NOT_DELIVERED, stage('telegram_probe'), failed('cleanup', 'cleanup_failed'));
      const decided = decide(list, notification(arrivals([webhook(), webhook()])), telegramState({ found: false,
        probe: { sentAt: 'x',
          arrivedMs: 10,
          readsOk: true } }));

      expect(decided.verdict).toMatchObject({ failedStage: 'telegram_delivered',
        error: { errorClass: 'telegram_not_delivered' } });
    });
  });

  it('puts the probe into the telegram field of the result', () => {
    const decided = decide(stages(NOT_DELIVERED, stage('telegram_probe')), notification(), telegramState({ found: false,
      latencyMs: undefined,
      probe: { sentAt: '2026-01-01T00:00:01.000Z',
        arrivedMs: 900,
        readsOk: true } }));

    expect(decided.telegram).toEqual({ unmatched: 1,
      probe: { sentAt: '2026-01-01T00:00:01.000Z',
        arrivedMs: 900 } });
  });
});
