import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HawkApi } from '../../../src/clients/hawk-api.js';
import type { RunResult, StageName, StageResult } from '../../../src/engine/result.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { createProvisioner } from '../../../src/notifications/provisioning.js';
import type { Receiver } from '../../../src/receiver/server.js';
import { httpAddress } from '../../support/address.js';
import { startDeadPort } from '../../support/dead-port.js';
import { TEST_RECEIVER_SECRET } from '../../support/env.js';
import { createFakeClock } from '../../support/fake-clock.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { CollectorReplyOverride, FakeHawk } from '../../support/fake-hawk/index.js';
import { createNotificationTestDeps, createTestDeps } from '../../support/scenario.js';
import type { NotificationTestDeps, NotificationTestOptions } from '../../support/scenario.js';
import type { PlanOptions } from '../../../src/scenarios/send-and-receive/plan.js';
import { runSendAndReceive } from '../../../src/scenarios/send-and-receive/run.js';
import { runCheckNotification } from '../../../src/scenarios/check-notification/run.js';
import type { NotificationDeps } from '../../../src/scenarios/check-notification/run.js';

const SECOND_SUBMISSION = 2;
const RUN_ID = `r${'a'.repeat(15)}`;
const NOTIFIED: StageName[] = ['collector_availability', 'api_availability', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'event_repeated', 'threshold_formed', 'cleanup'];
const QUOTA_REFUSAL: CollectorReplyOverride = { status: 402,
  body: JSON.stringify({ code: 402,
    error: true,
    message: 'Project has exceeded the events limit' }) };
// Short timeouts for tests that wait for a stage to give up; the HTTP timeout stays below each of them.
const IMPATIENT = { HTTP_TIMEOUT_MS: '300',
  EVENT_VISIBLE_TIMEOUT_MS: '800' };

/** A webhook body as the tests change it. */
interface WebhookJson {
  /** Payload with the parts that tests touch. */
  payload: WebhookPayloadJson;
}

/** The project of a webhook body. */
interface WebhookProjectJson {
  /** Id of the project. */
  id: string;
}

/** The event of a webhook body. */
interface WebhookEventBodyJson {
  /** Id of the event. */
  id: string;
  /** Title of the event. */
  title: string;
}

/** The payload of a webhook body. */
interface WebhookPayloadJson {
  /** Project of the notification. */
  project?: WebhookProjectJson;
  /** Events of the notification. */
  events?: WebhookEventJson[];
}

/** One event of a webhook body. */
interface WebhookEventJson {
  /** The event. */
  event: WebhookEventBodyJson;
}

let hawk: FakeHawk;
let current: NotificationTestDeps | undefined;
const servers: Server[] = [];

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  await hawk.close();
});

/**
 * Builds the dependencies of a run and remembers them for cleanup.
 * @param options Setup overrides.
 * @returns Dependencies and the notification parts.
 */
async function start(options: NotificationTestOptions = {}): Promise<NotificationTestDeps> {
  current = await createNotificationTestDeps(hawk, options);

  return current;
}

/**
 * Runs the scenario.
 * @param parts Dependencies from `start`.
 * @param overrides Dependencies that replace the built ones.
 * @param plan Run number and overrides.
 * @returns Result of the run.
 */
async function go(parts: NotificationTestDeps, overrides: Partial<NotificationDeps> = {}, plan: PlanOptions = { sequence: 1 }): Promise<RunResult> {
  return runCheckNotification({ ...parts.notificationDeps,
    ...overrides }, plan);
}

/**
 * Finds a stage in a result.
 * @param result Result whose stages are searched.
 * @param name Stage to look for.
 * @returns The recorded stage; throws when it is missing.
 */
function stageOf(result: RunResult, name: StageName): StageResult {
  const found = result.stages.find(item => item.name === name);

  if (found === undefined) {
    throw new Error(`stage ${name} is missing`);
  }

  return found;
}

/**
 * Hides the events of a run from the API search, as if Hawk did not show them.
 * @param api Real client.
 * @returns Client whose search finds nothing.
 */
function blind(api: HawkApi): HawkApi {
  return { ...api,
    findEvents: () => Promise.resolve([]) };
}

/**
 * Starts a tiny server that answers the probe by a script.
 * @param answer Called per request with its number from 1.
 * @returns Address that points at the server.
 */
async function probeServer(answer: (hit: number) => Promise<string>): Promise<ReturnType<typeof httpAddress>> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    answer(hits).then((body) => {
      res.end(body);
    }, () => undefined);
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return httpAddress((server.address() as AddressInfo).port);
}

/**
 * Starts a port whose server resets every connection and closes it with the test.
 * @returns Number of that port.
 */
async function deadPort(): Promise<number> {
  const dead = await startDeadPort();

  servers.push(dead.server);

  return dead.port;
}

describe('a healthy fake Hawk', () => {
  it('is ok with both channels, latencies, and the event id and link of the original event', async () => {
    const parts = await start();
    const result = await go(parts);

    expect(result.status).toBe('ok');
    expect(result.scenario).toBe('check-notification');
    expect(result.title).toBe(`[e2e:fake] ${RUN_ID} check-notification`);
    expect(result.stages.map(stage => stage.name)).toEqual(NOTIFIED);
    expect(result.stages.map(stage => stage.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'skipped', 'skipped', 'ok']);
    expect(result.warnings).toEqual([]);
    expect(result.notification?.webhook?.latencyMs).toBeTypeOf('number');
    expect(result.notification?.loop?.latencyMs).toBeTypeOf('number');
    expect(result.notification?.webhook?.eventId).toBe(result.event?.originalEventId);
    expect(result.notification?.unmatched).toBe(0);
    expect(result.provisioning).toEqual({ action: 'none',
      deleted: 0,
      matchChanged: false });
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
    expect(parts.receiver.counts(RUN_ID)).toEqual({ webhook: [],
      loop: [],
      threshold: [],
      unmatched: 0 });
  });

  it('creates the rule on the first run and skips the check while Hawk may hold the old rules', async () => {
    const clock = createFakeClock();
    const parts = await start({ preProvision: false });
    const provisioner = createProvisioner({ api: parts.deps.api,
      clock,
      projectId: hawk.projectId,
      instanceId: parts.deps.config.instanceId,
      secret: TEST_RECEIVER_SECRET,
      loop: true,
      warmupMs: 65_000 });
    const result = await go(parts, { provisioner });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'notification_formed')).toMatchObject({ status: 'skipped',
      details: { reason: 'rule_cache_warmup' } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^Notification check skipped: the notification rule changed \d+ s ago, Hawk caches rules for 60 s$/u);
    expect(result.provisioning).toEqual({ action: 'created',
      deleted: 0,
      matchChanged: true });
    expect(stageOf(result, 'event_visible').status).toBe('ok');
    expect(result.cleanup.status).toBe('ok');
  });

  it('registers the run before the send: the collector answers only after the webhook was delivered', async () => {
    const parts = await start();

    hawk.collector.knobs.holdReply = async (event) => {
      if (event) {
        await hawk.notifier.delivered(event.id);
      }
    };

    const result = await go(parts);

    expect(result.status).toBe('ok');
    expect(result.notification?.unmatched).toBe(0);
    expect(result.notification?.webhook).toBeDefined();
    expect(result.warnings).toEqual([]);
  });
});

describe('one channel', () => {
  it.each([
    ['webhook', 'loop', 'loopOff'],
    ['loop', 'webhook', 'webhookOff'],
  ] as const)('only the %s arrives: ok with a warning, and the wait for the %s ends with the pair wait', async (arrived, missing, knob) => {
    const parts = await start();

    hawk.notifier.knobs[knob] = true;

    const result = await go(parts);
    const formed = stageOf(result, 'notification_formed');

    expect(result.status).toBe('ok');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(new RegExp(`^Only the ${arrived} notification arrived; the ${missing} sender did not deliver within \\d+ ms$`, 'u'));
    expect(result.notification?.[missing]).toBeUndefined();
    // The pair wait is 200 ms, the timeout 800 ms.
    expect(formed.durationMs).toBeLessThan(parts.deps.config.notifications.timeoutMs);
  });

  it('the second channel comes after the pair wait but before the end: ok, warning "arrived after the pair wait"', async () => {
    const parts = await start({ env: { LATE_DUPLICATE_WAIT_MS: '1600',
      CLEANUP_TIMEOUT_MS: '8000' } });

    // The pair wait is 200 ms; the loop is 1 s late and the cleanup pause lasts 1.6 s, so a slow webhook still leaves 0.7 s of room.
    hawk.notifier.knobs.delayMs = { loop: 1000 };

    const result = await go(parts);

    expect(result.status).toBe('ok');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^The loop notification arrived after the pair wait, \d+(\.\d)? (ms|s) after the send$/u);
    expect(result.notification?.loop?.latencyMs).toBeGreaterThan(500);
  });

  it('the first channel comes shortly before the timeout: the wait for the second does not go past the timeout', async () => {
    const parts = await start({ env: { NOTIFICATION_TIMEOUT_MS: '2000',
      NOTIFICATION_PAIR_WAIT_MS: '1900' } });

    hawk.notifier.knobs.loopOff = true;
    hawk.notifier.knobs.delayMs = { webhook: 1000 };

    const result = await go(parts);
    const formed = stageOf(result, 'notification_formed');

    expect(result.status).toBe('ok');
    expect(result.warnings[0]).toMatch(/^Only the webhook/u);
    // Without the cap the wait would last 1000 + 1900 ms.
    expect(formed.durationMs).toBeLessThan(2450);
    expect(formed.durationMs).toBeGreaterThanOrEqual(1900);
  });
});

describe('nothing arrives', () => {
  it('a notifier that is off is notification_timeout and the text names the notifier', async () => {
    const parts = await start({ env: { NOTIFICATION_TIMEOUT_MS: '400' } });

    hawk.notifier.knobs.off = true;

    const result = await go(parts);

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'notification_timeout',
      culprit: 'hawk' });
    expect(result.message).toContain('notifier');
    expect(stageOf(result, 'event_visible').status).toBe('ok');
    expect(result.cleanup.status).toBe('ok');
  });

  it('a receiver that stopped answering after the setup is receiver_unreachable', async () => {
    const parts = await start({ env: { NOTIFICATION_TIMEOUT_MS: '400' } });
    const real = parts.receiver;
    const dying: Receiver = { ...real,
      expect: (runId) => {
        real.expect(runId);
        real.close().catch(() => undefined);
      } };

    hawk.notifier.knobs.off = true;

    const result = await go(parts, { receiver: dying });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'receiver_unreachable',
      culprit: 'monitor' });
  });

  it('a notifier that is off and a recheck that answers slowly stay notification_timeout', async () => {
    const parts = await start({ env: { NOTIFICATION_TIMEOUT_MS: '300',
      HTTP_TIMEOUT_MS: '1000' } });
    const address = await probeServer(async hit => new Promise<string>((resolve) => {
      // The probe of the setup is the first request; the recheck is the next one and takes 250 ms.
      setTimeout(() => {
        resolve(parts.receiver.nonce);
      }, hit === 1 ? 0 : 250);
    }));

    hawk.notifier.knobs.off = true;

    const result = await go(parts, { resolveAddress: () => Promise.resolve(address) });

    expect(result.errorClass).toBe('notification_timeout');
    expect(result.failedStage).toBe('notification_formed');
  });
});

describe('a notification that does not fit the event', () => {
  it('a wrong project id is notification_mismatch with the field', async () => {
    const parts = await start();

    hawk.notifier.knobs.mutateWebhookBody = (body) => {
      const { payload } = body as unknown as WebhookJson;

      payload.project!.id = 'other';

      return body;
    };

    const result = await go(parts);

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'notification_mismatch' });
    expect(result.message).toContain('webhook.project.id');
  });

  it('a body that is not JSON is notification_mismatch', async () => {
    const parts = await start();

    hawk.notifier.knobs.webhookRawBody = `not json ${RUN_ID}`;

    const result = await go(parts);

    expect(result.errorClass).toBe('notification_mismatch');
    expect(result.message).toContain('webhook.body');
  });

  it('a mangled title with the right run id is notification_mismatch', async () => {
    const parts = await start();

    hawk.notifier.knobs.mutateWebhookBody = (body) => {
      const { payload } = body as unknown as WebhookJson;

      payload.events![0]!.event.title += ' changed';

      return body;
    };

    const result = await go(parts);

    expect(result.errorClass).toBe('notification_mismatch');
    expect(result.message).toContain('webhook.title');
  });

  it('an event id that is not the original event is notification_mismatch after the group', async () => {
    const parts = await start();

    hawk.notifier.knobs.mutateWebhookBody = (body) => {
      const { payload } = body as unknown as WebhookJson;

      payload.events![0]!.event.id = 'another-event';

      return body;
    };

    const result = await go(parts);

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'notification_mismatch' });
    expect(result.message).toContain('webhook.event.id');
    expect(stageOf(result, 'notification_formed').status).toBe('ok');
  });

  it('a webhook that arrives twice after the stage is done is duplicate_notification', async () => {
    const parts = await start();
    let resume = (): void => undefined;
    const trigger = new Promise<void>((resolve) => {
      resume = resolve;
    });

    hawk.notifier.knobs.duplicate = { channel: 'webhook',
      after: async () => trigger };

    const api: HawkApi = { ...parts.deps.api,
      removeEvent: async (projectId, eventId, signal) => {
        // The second webhook is sent during cleanup, and cleanup goes on only after it has been received.
        resume();
        await hawk.notifier.idle();

        return parts.deps.api.removeEvent(projectId, eventId, signal);
      } };
    const result = await go(parts, { api });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_formed',
      errorClass: 'duplicate_notification' });
    expect(result.message).toBe('The webhook notification arrived 2 times');
    expect(stageOf(result, 'notification_formed').status).toBe('ok');
  });
});

describe('a run without a repeat', () => {
  it('fails with threshold_early when the threshold rule fires on the first event', async () => {
    const parts = await start();

    hawk.notifier.knobs.fireThresholdOnFirst = true;

    const result = await go(parts, {}, { sequence: 1,
      repeat: false });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'threshold_formed',
      errorClass: 'threshold_early' });
  });
});

describe('a repeat run', () => {
  it('is ok with the threshold notification timed from the repeat', async () => {
    const parts = await start();
    const result = await go(parts, {}, { sequence: 1,
      repeat: true });

    expect(result.status).toBe('ok');
    expect(result.stages.map(stage => stage.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(result.notification?.threshold?.latencyMs).toBeTypeOf('number');
    expect(result.notification?.unmatched).toBe(0);
    expect(result.event?.totalCount).toBe(2);
  });

  it('a threshold rule that is gone makes the run fail with notification_timeout of the threshold channel', async () => {
    const parts = await start({ env: IMPATIENT });
    const threshold = hawk.rules.list(hawk.projectId).find(rule => rule.whatToReceive === 'SEEN_MORE' && rule.including.length === 1);

    hawk.rules.remove(hawk.projectId, threshold?.id ?? '');

    // A provisioner that sees no change keeps the run out of the warmup skip.
    const result = await go(parts, { provisioner: { provision: async () => Promise.resolve({ action: 'none',
      deleted: 0,
      matchChanged: false,
      ruleId: 'x',
      thresholdRuleId: 'y' }),
    warmupRemainingMs: () => 0 } }, { sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'threshold_formed',
      errorClass: 'notification_timeout' });
    expect(result.message).toContain('threshold');
  });
});

describe('the event is not shown', () => {
  it('an uncertain accept, no event in the API, a notification that arrived: the failure is on event_visible', async () => {
    const parts = await start({ env: IMPATIENT });

    // The answer comes after the client gave up, so the accept is uncertain although the event was stored.
    hawk.collector.knobs.replyDelayMs = 600;

    const result = await go(parts, { api: blind(parts.deps.api) });

    expect(stageOf(result, 'collector_accept').status).toBe('uncertain');
    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found' });
    expect(result.message).toContain('a notification for this event arrived, so the collector accepted it');
  });

  it('a failed event_visible lets notification_formed finish and skips event_repeated', async () => {
    const parts = await start({ env: IMPATIENT });
    const result = await go(parts, { api: blind(parts.deps.api) }, { sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found' });
    expect(stageOf(result, 'notification_formed').status).toBe('ok');
    expect(stageOf(result, 'event_repeated').status).toBe('skipped');
  });
});

describe('setup failures', () => {
  it('a tunnel without an address fails notification_setup and sends nothing to the collector', async () => {
    const parts = await start({ preProvision: false });
    const result = await go(parts, { resolveAddress: () => Promise.reject(new CheckError('tunnel_unavailable', { detail: 'down' })) });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_setup',
      errorClass: 'tunnel_unavailable' });
    expect(result.stages.slice(3, 7).every(stage => stage.status === 'skipped')).toBe(true);
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
    expect(hawk.collector.posts).toBe(0);
    expect(result.notification).toBeUndefined();
    expect(result.provisioning).toBeUndefined();
  });

  it('a receiver that the address does not lead to fails notification_setup and sends nothing', async () => {
    const dead = httpAddress(await deadPort());
    const parts = await start({ preProvision: false,
      resolveAddress: () => Promise.resolve(dead) });
    const result = await go(parts);

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_setup',
      errorClass: 'receiver_unreachable' });
    expect(hawk.collector.posts).toBe(0);
  });

  it('"Cannot resolve webhook hostname" for a fixed address is notification_endpoint_rejected', async () => {
    const parts = await start({ preProvision: false });

    hawk.api.knobs.unresolvableHosts = ['127.0.0.1'];

    const result = await go(parts);

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'notification_setup',
      errorClass: 'notification_endpoint_rejected' });
  });

  it('a failed accept skips the group and the repeat and leaves nothing to clean up', async () => {
    const parts = await start();

    // Submission 1 is the probe of the availability stage.
    hawk.collector.knobs.reply = submission => submission === SECOND_SUBMISSION ? QUOTA_REFUSAL : undefined;

    const result = await go(parts, {}, { sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_accept',
      errorClass: 'quota_exhausted' });
    expect(result.stages.slice(4, 7).every(stage => stage.status === 'skipped')).toBe(true);
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
  });
});

describe('secrets in the output', () => {
  it('logs and result hide the secret and the hostname, also in the answer of Hawk about an unresolvable host', async () => {
    const parts = await start({ preProvision: false });
    const tunnel = httpAddress(parts.receiver.port, 'tunnel');

    hawk.api.knobs.unresolvableHosts = ['127.0.0.1'];

    const result = await go(parts, { resolveAddress: () => Promise.resolve(tunnel) });
    const output = JSON.stringify([result, parts.logger.lines]);

    expect(result.errorClass).toBe('tunnel_unavailable');
    expect(result.message).toContain('***');
    expect(output).not.toContain(TEST_RECEIVER_SECRET);
    expect(output).not.toContain('127.0.0.1');
    expect(output).not.toContain(tunnel.baseUrl);
    expect(parts.secrets).toContain(tunnel.baseUrl);
  });

  it('a healthy run shows neither the secret nor the address', async () => {
    const parts = await start();
    const result = await go(parts);
    const output = JSON.stringify([result, parts.logger.lines]);

    expect(output).not.toContain(TEST_RECEIVER_SECRET);
    expect(output).not.toContain(parts.address.baseUrl);
    expect(output).not.toContain(parts.address.hostname);
  });
});

describe('cancelling from outside', () => {
  it('an abort after the send fails the group with "the run was cancelled" and cleanup removes the event', async () => {
    const parts = await start();
    const outside = new AbortController();
    const result = await go(parts, { signal: outside.signal,
      collector: { ...parts.deps.collector,
        send: async (...args) => {
          const outcome = await parts.deps.collector.send(...args);

          outside.abort();

          return outcome;
        } } });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'run_timeout',
      message: 'The run was cancelled' });
    expect(stageOf(result, 'collector_accept').status).toBe('ok');
    expect(stageOf(result, 'notification_formed')).toMatchObject({ status: 'failed',
      errorClass: 'run_timeout' });
    expect(stageOf(result, 'event_repeated').status).toBe('skipped');
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });
});

describe('send-and-receive-event', () => {
  it('runs as send-and-receive-event without any notification setting and sends the backtrace frame', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive(deps, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(result.scenario).toBe('send-and-receive-event');
    expect(result.stages.some(stage => stage.name.startsWith('notification'))).toBe(false);
    expect(result.notification).toBeUndefined();
    expect(result.provisioning).toBeUndefined();
  });
});
