import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundEvent } from '../../../src/clients/hawk-api.js';
import { runStage } from '../../../src/engine/stages.js';
import type { StageResult } from '../../../src/engine/result.js';
import type { StageSpec } from '../../../src/engine/stages.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { createProvisioner } from '../../../src/notifications/provisioning.js';
import type { Arrivals } from '../../../src/receiver/server.js';
import { createFakeClock } from '../../support/fake-clock.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { httpAddress } from '../../support/address.js';
import { startDeadPort } from '../../support/dead-port.js';
import { reservedPort } from '../../support/ports.js';
import { TEST_RECEIVER_SECRET } from '../../support/env.js';
import { createNotificationTestScenario } from '../../support/scenario.js';
import type { NotificationTestOptions, NotificationTestScenario } from '../../support/scenario.js';
import { systemClock } from '../../../src/time/clock.js';
import { collectorAcceptStage, eventRepeatedStage, eventVisibleStage } from '../../../src/scenarios/shared/delivery.js';
import { checkNotificationAgainstEvent, notificationBeforeSend, notificationFormedStage, notificationSetupStage, thresholdBeforeRepeat, thresholdFormedStage } from '../../../src/scenarios/check-notification/stages.js';
import type { NotificationContext } from '../../../src/scenarios/check-notification/stages.js';

const TIMEOUT_MS = 3000;
const FORMED_TIMEOUT_MS = 3000;

let hawk: FakeHawk;
let current: NotificationTestScenario | undefined;
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
 * Builds a notification scenario and remembers it for cleanup.
 * @param options Setup overrides.
 * @returns Scenario with its parts.
 */
async function scenario(options: NotificationTestOptions = {}): Promise<NotificationTestScenario> {
  current = await createNotificationTestScenario(hawk, options);

  return current;
}

/**
 * Runs one stage under the engine, as the scenario does.
 * @param spec Stage to run.
 * @param context Notification context.
 * @returns Recorded result.
 */
async function run(spec: StageSpec<NotificationContext>, context: NotificationContext): Promise<StageResult> {
  return runStage(spec, context, { clock: systemClock,
    runSignal: new AbortController().signal });
}

/**
 * Registers the run and sends the event, as stages 2 and 3 of the scenario do.
 * @param context Notification context.
 * @returns Result of the accept stage.
 */
async function sendEvent(context: NotificationContext): Promise<StageResult> {
  // Tests of the formed stage skip the setup stage, which would have found the address.
  context.address ??= current?.address;

  return run(collectorAcceptStage(TIMEOUT_MS, notificationBeforeSend(context)), context);
}

/**
 * Posts a body to a channel of the receiver the way Hawk would.
 * @param parts Scenario with the receiver.
 * @param channel Channel path.
 * @param body Raw body.
 * @param headers Request headers.
 */
async function post(parts: NotificationTestScenario, channel: 'webhook' | 'loop', body: string, headers: Record<string, string> = {}): Promise<void> {
  const response = await fetch(`${parts.address.baseUrl}/hooks/${channel}/${TEST_RECEIVER_SECRET}`, { method: 'POST',
    headers,
    body });

  await response.arrayBuffer();
}

/** Fields of a webhook body a test may break. */
interface WebhookOverrides {
  /** Project id. */
  projectId?: string;
  /** Event title. */
  title?: string;
  /** Event id. */
  eventId?: string;
  /** Type of the notification. */
  type?: string;
}

/** A tiny server that answers probes by a script. */
interface ProbeServer {
  /** Address that points at the server. */
  address: ReturnType<typeof httpAddress>;
  /**
   * Counts the requests seen.
   * @returns Number of requests.
   */
  hits(): number;
}

/** A webhook post to make by hand. */
interface WebhookPost {
  /** Builds the body. */
  body: (parts: NotificationTestScenario) => string;
  /** Request headers. */
  headers?: Record<string, string>;
}

/** What `formedWith` leaves behind. */
interface FormedRun {
  /** The scenario. */
  parts: NotificationTestScenario;
  /** Result of the stage. */
  result: StageResult;
}

/**
 * Builds a webhook body like Hawk's, with fields to break.
 * @param parts Scenario.
 * @param overrides Values that replace the good ones.
 * @returns JSON text.
 */
function webhookBody(parts: NotificationTestScenario, overrides: WebhookOverrides = {}): string {
  return JSON.stringify({ type: overrides.type ?? 'event',
    payload: { project: { id: overrides.projectId ?? parts.deps.config.hawk.projectId },
      events: [{ event: { id: overrides.eventId ?? 'event-1',
        title: overrides.title ?? parts.plan.title } }] } });
}

/**
 * Builds a one-entry header record, because the linter rejects dashed names in object literals.
 * @param name Name of the header, any case.
 * @param value Content of the header.
 * @returns Record with the single header.
 */
function header(name: string, value: string): Record<string, string> {
  return Object.fromEntries([[name, value]]);
}

const GOOD_HEADERS = Object.fromEntries([
  ['user-agent', 'Hawk-Webhook/1.0'],
  ['x-hawk-notification', 'event'],
  ['content-type', 'application/json'],
]);

/**
 * Starts a tiny server that answers the probe by a script.
 * @param answer Called per request with its number from 1; resolves to the body, or never for a silent request.
 * @returns Base URL and the number of requests seen.
 */
async function probeServer(answer: (hit: number) => Promise<string | undefined>): Promise<ProbeServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    answer(hits).then((body) => {
      if (body !== undefined) {
        res.end(body);
      }
    }, () => undefined);
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return { address: httpAddress((server.address() as AddressInfo).port),
    hits: () => hits };
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

describe('notificationSetupStage', () => {
  it('creates the rule, remembers the address and asks to mask it', async () => {
    const parts = await scenario({ preProvision: false });
    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'ok',
      details: { provisioning: { action: 'created',
        deleted: 0,
        matchChanged: true } } });
    expect(parts.context.address).toEqual(parts.address);
    expect(parts.context.notification.provisioning?.action).toBe('created');
    expect(parts.secrets).toContain(parts.address.baseUrl);
    expect(parts.secrets).toContain(parts.address.hostname);
    expect(parts.secrets).toContain('127.0.0.1');
    expect(hawk.rules.list(hawk.projectId).some(rule => rule.channels.webhook?.endpoint === `${parts.address.baseUrl}/hooks/webhook/${TEST_RECEIVER_SECRET}`)).toBe(true);
  });

  it('is a no-op for a rule that is already right', async () => {
    const parts = await scenario();
    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result.details?.provisioning).toMatchObject({ action: 'none',
      matchChanged: false });
  });

  it('fails with the class of the address lookup and does not touch the rules', async () => {
    const parts = await scenario({ preProvision: false,
      resolveAddress: () => Promise.reject(new CheckError('tunnel_unavailable', { detail: 'down' })) });
    const before = hawk.rules.version(hawk.projectId);
    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'tunnel_unavailable' });
    expect(hawk.rules.version(hawk.projectId)).toBe(before);
    expect(hawk.collector.posts).toBe(0);
  });

  it('fails with receiver_unreachable on a closed port and does not touch the rules', async () => {
    const dead = httpAddress(await deadPort());
    const parts = await scenario({ preProvision: false,
      resolveAddress: () => Promise.resolve(dead) });
    const before = hawk.rules.version(hawk.projectId);
    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(hawk.rules.version(hawk.projectId)).toBe(before);
  });

  it('retries the probe once after a timeout', async () => {
    const parts = await scenario({ env: { HTTP_TIMEOUT_MS: '300' } });
    const slow = await probeServer(hit => hit === 1 ? new Promise<string>(() => undefined) : Promise.resolve(parts.receiver.nonce));

    parts.context.resolveAddress = () => Promise.resolve(slow.address);

    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result.status).toBe('ok');
    expect(slow.hits()).toBe(2);
  });

  it('passes the error of the provisioner on', async () => {
    const parts = await scenario();

    parts.context.provisioner = { provision: () => Promise.reject(new CheckError('provisioning_conflict', { detail: 'parallel' })),
      warmupRemainingMs: () => 0 };

    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'provisioning_conflict' });
  });
});

describe('notificationSetupStage after the address changed', () => {
  it('waits until the new address answers the self-check, then provisions and remembers the host', async () => {
    const parts = await scenario({ preProvision: false });
    const server = await probeServer(hit => Promise.resolve(hit < 3 ? 'not the receiver' : parts.receiver.nonce));

    parts.context.resolveAddress = () => Promise.resolve(server.address);
    parts.context.lastHostname = { value: 'old.example.test' };
    parts.context.addressPollMs = 20;

    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result.status).toBe('ok');
    expect(server.hits()).toBe(3);
    expect(parts.context.lastHostname.value).toBe(server.address.hostname);
    expect(parts.context.notification.provisioning?.action).toBe('created');
  });

  it('fails with the last self-check error when the timeout ends first, and leaves the rule and the remembered host alone', async () => {
    const parts = await scenario({ preProvision: false });
    const server = await probeServer(() => Promise.resolve('not the receiver'));
    const before = hawk.rules.version(hawk.projectId);

    parts.context.resolveAddress = () => Promise.resolve(server.address);
    parts.context.lastHostname = { value: 'old.example.test' };
    parts.context.addressPollMs = 20;

    const result = await run(notificationSetupStage(400), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(server.hits()).toBeGreaterThan(1);
    expect(hawk.rules.version(hawk.projectId)).toBe(before);
    expect(parts.context.lastHostname.value).toBe('old.example.test');
  });

  it('does not wait for the first address of the process and remembers it', async () => {
    const parts = await scenario();

    parts.context.lastHostname = {};

    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result.status).toBe('ok');
    expect(parts.context.lastHostname.value).toBe(parts.address.hostname);
  });

  it('does not wait when the host is the same as before', async () => {
    const parts = await scenario({ env: { HTTP_TIMEOUT_MS: '300' } });
    const server = await probeServer(() => Promise.resolve('not the receiver'));

    parts.context.resolveAddress = () => Promise.resolve(server.address);
    parts.context.lastHostname = { value: server.address.hostname };

    const result = await run(notificationSetupStage(TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    // The ordinary probe, not the waiting loop, judged it.
    expect(server.hits()).toBeLessThanOrEqual(3);
  });
});

/** What a scripted server answers. */
interface StatusAnswer {
  /** HTTP status. */
  status: number;
  /** Body text. */
  body: string;
}

/** A stage result with its wall time. */
interface TimedStage {
  /** Recorded result. */
  result: StageResult;
  /** Wall time in milliseconds. */
  ms: number;
}

/**
 * Starts a tiny server that answers the probe with a status and a body by a script.
 * @param answer Called per request with its number from 1; undefined means the request is never answered.
 * @returns Tunnel-sourced address of the server and the number of requests seen.
 */
async function statusServer(answer: (hit: number) => StatusAnswer | undefined): Promise<ProbeServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();

    const reply = answer(hits);

    if (reply !== undefined) {
      res.statusCode = reply.status;
      res.end(reply.body);
    }
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return { address: httpAddress((server.address() as AddressInfo).port, 'tunnel'),
    hits: () => hits };
}

/**
 * Measures how long a stage takes.
 * @param spec Stage to run.
 * @param context Notification context.
 * @returns Result and wall time in milliseconds.
 */
async function timed(spec: StageSpec<NotificationContext>, context: NotificationContext): Promise<TimedStage> {
  const start = performance.now();
  const result = await run(spec, context);

  return { result,
    ms: performance.now() - start };
}

describe('notificationSetupStage through a tunnel', () => {
  const TUNNEL_ENV = { HTTP_TIMEOUT_MS: '300' };

  /**
   * Builds a scenario whose address is the given one.
   * @param address Address to resolve.
   * @param env Extra environment.
   * @returns Scenario with the address and a short poll.
   */
  async function tunnelScenario(address: ProbeServer['address'], env: Record<string, string> = TUNNEL_ENV): Promise<NotificationTestScenario> {
    const parts = await scenario({ preProvision: false,
      env });

    parts.context.resolveAddress = () => Promise.resolve(address);
    parts.context.addressPollMs = 20;

    return parts;
  }

  it.each([530, 502])('bridges a gap: %i for three hits, then the nonce', async (status) => {
    const parts = await scenario({ preProvision: false,
      env: TUNNEL_ENV });
    const server = await statusServer(hit => ({ status: hit <= 3 ? status : 200,
      body: hit <= 3 ? 'gap' : parts.receiver.nonce }));

    parts.context.resolveAddress = () => Promise.resolve(server.address);
    parts.context.addressPollMs = 20;

    const result = await run(notificationSetupStage(3000), parts.context);

    expect(result.status).toBe('ok');
    expect(server.hits()).toBe(4);
    expect(parts.context.notification.provisioning?.action).toBe('created');
  });

  it('bridges a refused connection until the port listens', async () => {
    const port = await reservedPort();
    const parts = await tunnelScenario(httpAddress(port, 'tunnel'));

    setTimeout(() => {
      const late = createServer((req, res) => {
        req.resume();
        res.end(parts.receiver.nonce);
      });

      servers.push(late);
      late.listen(port, '127.0.0.1');
    }, 150);

    const result = await run(notificationSetupStage(3000), parts.context);

    expect(result.status).toBe('ok');
  });

  it('gives up inside the window when the tunnel keeps answering 530', async () => {
    const server = await statusServer(() => ({ status: 530,
      body: 'gap' }));
    const parts = await tunnelScenario(server.address);
    const before = hawk.rules.version(hawk.projectId);
    const { result, ms } = await timed(notificationSetupStage(3000), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(result.message).toContain('HTTP 530');
    expect(server.hits()).toBeGreaterThan(1);
    expect(hawk.rules.version(hawk.projectId)).toBe(before);
    expect(ms).toBeLessThan(2700);
  });

  it('cuts the last probe at the window end', async () => {
    const server = await statusServer(() => undefined);
    const parts = await tunnelScenario(server.address, { HTTP_TIMEOUT_MS: '1000' });
    const { result, ms } = await timed(notificationSetupStage(2600), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(ms).toBeLessThan(950);
  });

  it('waits for a new tunnel host inside the same window', async () => {
    const server = await statusServer(() => ({ status: 200,
      body: 'not the receiver' }));
    const parts = await tunnelScenario(server.address);

    parts.context.lastHostname = { value: 'old.example.test' };

    const { result, ms } = await timed(notificationSetupStage(3000), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(ms).toBeLessThan(2700);
    expect(parts.context.lastHostname.value).toBe('old.example.test');
  });

  it('keeps the ordinary probe for a fixed address', async () => {
    const server = await statusServer(() => ({ status: 530,
      body: 'gap' }));
    const parts = await tunnelScenario({ ...server.address,
      source: 'config' });
    const result = await run(notificationSetupStage(3000), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable' });
    expect(server.hits()).toBe(3);
  });
});

describe('notificationBeforeSend', () => {
  it('registers the run before the event is sent and notes no warmup for an unchanged rule', async () => {
    const parts = await scenario();

    await sendEvent(parts.context);

    expect(parts.receiver.counts(parts.plan.runId)).toEqual({ webhook: [],
      loop: [],
      threshold: [],
      telegram: [],
      unmatched: 0 });
    expect(parts.context.notification.warmup).toBe(false);
  });

  it('notes the warmup when the rule changed in this process', async () => {
    const clock = createFakeClock();
    const base = await scenario({ preProvision: false });

    base.context.provisioner = createProvisioner({ api: base.deps.api,
      clock,
      projectId: hawk.projectId,
      instanceId: base.deps.config.instanceId,
      secret: TEST_RECEIVER_SECRET,
      loop: true,
      warmupMs: 65_000 });

    await run(notificationSetupStage(TIMEOUT_MS), base.context);
    await clock.advance(3000);
    notificationBeforeSend(base.context)();

    expect(base.context.notification.warmup).toBe(true);
    expect(base.context.notification.ruleChangedAgoMs).toBe(3000);
  });
});

describe('notificationFormedStage', () => {
  it('is ok when both channels arrive for this event', async () => {
    const parts = await scenario();

    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);
    const [stored] = hawk.store.all(hawk.projectId);
    const latency = result.details?.latencyMs as Record<string, number>;

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBeUndefined();
    expect(result.details?.eventId).toBe(stored?.id);
    expect(latency.webhook).toBeTypeOf('number');
    expect(latency.loop).toBeTypeOf('number');
    expect(parts.context.notification.arrivals?.webhook).toHaveLength(1);
    expect(parts.context.notification.arrivals?.loop).toHaveLength(1);
  });

  it('with the loop channel off waits for the webhook only', async () => {
    const parts = await scenario({ env: { NOTIFY_LOOP: 'false' } });

    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toBeUndefined();
    expect(parts.context.notification.arrivals?.loop).toHaveLength(0);
  });

  it.each([
    ['webhook', 'loop', 'loopOff'],
    ['loop', 'webhook', 'webhookOff'],
  ] as const)('is ok with a warning when only the %s arrives', async (arrived, missing, knob) => {
    const parts = await scenario();

    hawk.notifier.knobs[knob] = true;
    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result.status).toBe('ok');
    expect(result.details?.warning).toMatch(new RegExp(`^Only the ${arrived} notification arrived; the ${missing} sender did not deliver within \\d+ ms$`, 'u'));
    // The pair wait (200 ms) ends the wait long before the timeout (800 ms).
    expect(result.durationMs).toBeLessThan(parts.context.settings.timeoutMs);
  });

  it('fails with notification_timeout naming the notifier when nothing arrives', async () => {
    const parts = await scenario({ env: { NOTIFICATION_TIMEOUT_MS: '400' } });

    hawk.notifier.knobs.off = true;
    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'notification_timeout',
      culprit: 'hawk' });
    expect(result.message).toContain('Neither channel arrived');
  });

  it('says the notifier and the sender cannot be told apart when the loop is off', async () => {
    const parts = await scenario({ env: { NOTIFICATION_TIMEOUT_MS: '400',
      NOTIFY_LOOP: 'false' } });

    hawk.notifier.knobs.off = true;
    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result.errorClass).toBe('notification_timeout');
    expect(result.message).toContain('with the loop channel off');
  });

  it('fails with receiver_unreachable when the receiver stopped answering after the setup', async () => {
    const parts = await scenario({ env: { NOTIFICATION_TIMEOUT_MS: '400' } });

    hawk.notifier.knobs.off = true;
    await sendEvent(parts.context);
    await parts.receiver.close();

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'receiver_unreachable',
      culprit: 'monitor' });
  });

  it('keeps notification_timeout when the recheck probe is slow but answers', async () => {
    const parts = await scenario({ env: { NOTIFICATION_TIMEOUT_MS: '400',
      HTTP_TIMEOUT_MS: '1000' } });
    const slow = await probeServer(() => new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve(parts.receiver.nonce);
      }, 300);
    }));

    hawk.notifier.knobs.off = true;
    await sendEvent(parts.context);
    parts.context.address = slow.address;

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result.errorClass).toBe('notification_timeout');
    expect(slow.hits()).toBe(1);
  });

  it('is skipped with a warning while the rule cache may be stale', async () => {
    const clock = createFakeClock();
    const parts = await scenario({ preProvision: false });

    parts.context.provisioner = createProvisioner({ api: parts.deps.api,
      clock,
      projectId: hawk.projectId,
      instanceId: parts.deps.config.instanceId,
      secret: TEST_RECEIVER_SECRET,
      loop: true,
      warmupMs: 65_000 });

    await run(notificationSetupStage(TIMEOUT_MS), parts.context);
    await clock.advance(2500);
    await sendEvent(parts.context);

    const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result.status).toBe('skipped');
    expect(result.details).toMatchObject({ reason: 'rule_cache_warmup',
      warning: 'Notification check skipped: the notification rule changed 3 s ago, Hawk caches rules for 60 s',
      warmupRemainingMs: 62_500 });
    expect(parts.context.notification.arrivals).toBeUndefined();
  });

  describe('mismatch', () => {
    /**
     * Sends nothing through the notifier and posts the given bodies by hand.
     * @param webhook Webhook body and headers, or undefined for none.
     * @param loop Loop body, or undefined for none.
     * @param setup Scenario overrides.
     * @returns Scenario and the result of the formed stage.
     */
    async function formedWith(webhook: WebhookPost | undefined, loop: ((parts: NotificationTestScenario) => string) | undefined, setup: NotificationTestOptions = {}): Promise<FormedRun> {
      const scene = await scenario(setup);

      hawk.notifier.knobs.off = true;
      await sendEvent(scene.context);

      if (webhook) {
        await post(scene, 'webhook', webhook.body(scene), webhook.headers ?? GOOD_HEADERS);
      }

      if (loop) {
        await post(scene, 'loop', loop(scene));
      }

      return { parts: scene,
        result: await run(notificationFormedStage(FORMED_TIMEOUT_MS), scene.context) };
    }

    const goodLoop = (parts: NotificationTestScenario): string => JSON.stringify({ text: `**${parts.plan.title}**` });

    it('passes a good hand-made pair', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts) }, goodLoop);

      expect(result.status).toBe('ok');
    });

    it.each([
      ['webhook.user-agent', { ...GOOD_HEADERS,
        ...header('user-agent', 'curl/8') }],
      ['webhook.x-hawk-notification', header('user-agent', 'Hawk-Webhook/1.0')],
    ] as const)('names %s when a header is wrong', async (field, headers) => {
      const { result } = await formedWith({ body: parts => webhookBody(parts),
        headers }, goodLoop);

      expect(result).toMatchObject({ status: 'failed',
        errorClass: 'notification_mismatch',
        culprit: 'hawk' });
      expect(result.message).toContain(field);
    });

    it('accepts header names in any case', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts),
        headers: { ...header('USER-AGENT', 'Hawk-Webhook/1.0'),
          ...header('X-Hawk-Notification', 'event') } }, goodLoop);

      expect(result.status).toBe('ok');
    });

    it('names webhook.body when the body is not JSON', async () => {
      const { result } = await formedWith({ body: parts => `not json ${parts.plan.runId}` }, goodLoop);

      expect(result.errorClass).toBe('notification_mismatch');
      expect(result.message).toContain('webhook.body');
    });

    it('names webhook.project.id when the project differs', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts, { projectId: 'other' }) }, goodLoop);

      expect(result.message).toContain('webhook.project.id');
      expect(result.message).toContain('other');
    });

    it('names webhook.type when the type is not event', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts, { type: 'other' }) }, goodLoop);

      expect(result.errorClass).toBe('notification_mismatch');
      expect(result.message).toContain('webhook.type');
    });

    it('names webhook.title when the title differs but the run id is right', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts, { title: `${parts.plan.title} changed` }) }, goodLoop);

      expect(result.errorClass).toBe('notification_mismatch');
      expect(result.message).toContain('webhook.title');
    });

    it('names loop.title when the loop body lacks the title', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts) }, parts => JSON.stringify({ text: `**${parts.plan.runId} changed**` }));

      expect(result.errorClass).toBe('notification_mismatch');
      expect(result.message).toContain('loop.title');
    });

    it('checks the webhook before the loop', async () => {
      const { result } = await formedWith({ body: parts => webhookBody(parts, { projectId: 'other' }) }, parts => `**${parts.plan.runId}**`);

      expect(result.message).toContain('webhook.project.id');
    });

    it('keeps the arrivals on a failure for the verdict', async () => {
      const { parts: scene } = await formedWith({ body: parts => webhookBody(parts, { projectId: 'other' }) }, goodLoop);

      expect(scene.context.notification.arrivals?.webhook).toHaveLength(1);
    });

    it('counts a post for another run and warns', async () => {
      const parts = await scenario();

      hawk.notifier.knobs.off = true;
      await sendEvent(parts.context);
      await post(parts, 'webhook', '{"other":"body"}', GOOD_HEADERS);
      await post(parts, 'webhook', webhookBody(parts), GOOD_HEADERS);
      await post(parts, 'loop', goodLoop(parts));

      const result = await run(notificationFormedStage(FORMED_TIMEOUT_MS), parts.context);

      expect(result.status).toBe('ok');
      expect(result.details?.unmatched).toBe(1);
      expect(result.details?.warnings).toEqual(['1 notification(s) with a valid secret but another run id arrived while waiting']);
    });
  });
});

describe('checkNotificationAgainstEvent', () => {
  const event: FoundEvent = { originalEventId: 'event-1',
    groupHash: 'g',
    totalCount: 1,
    catcherType: 'errors/nodejs',
    title: 't',
    context: null };

  /**
   * Builds arrivals with one POST per given channel.
   * @param webhook Webhook body.
   * @param loop Loop body.
   * @returns Arrivals with the given bodies.
   */
  function arrivals(webhook?: string, loop?: string): Arrivals {
    const arrival = (channel: 'webhook' | 'loop', rawBody: string): Arrivals['webhook'][number] => ({ channel,
      atMs: 0,
      headers: {},
      rawBody });

    return { webhook: webhook === undefined ? [] : [arrival('webhook', webhook)],
      loop: loop === undefined ? [] : [arrival('loop', loop)],
      threshold: [],
      telegram: [],
      unmatched: 0 };
  }

  const goodWebhook = JSON.stringify({ payload: { events: [{ event: { id: 'event-1' } }] } });
  const goodLoop = '[Details](https://garage/project/p1/event/event-1/)';

  it('accepts the id and the link of this event', () => {
    expect(checkNotificationAgainstEvent(arrivals(goodWebhook, goodLoop), event, 'p1')).toBeUndefined();
  });

  it('accepts a single channel and an empty set', () => {
    expect(checkNotificationAgainstEvent(arrivals(goodWebhook), event, 'p1')).toBeUndefined();
    expect(checkNotificationAgainstEvent(arrivals(undefined, goodLoop), event, 'p1')).toBeUndefined();
    expect(checkNotificationAgainstEvent(arrivals(), event, 'p1')).toBeUndefined();
  });

  it('names webhook.event.id when the id differs', () => {
    const error = checkNotificationAgainstEvent(arrivals(JSON.stringify({ payload: { events: [{ event: { id: 'event-2' } }] } })), event, 'p1');

    expect(error?.errorClass).toBe('notification_mismatch');
    expect(error?.message).toContain('webhook.event.id');
    expect(error?.message).toContain('event-2');
  });

  it('names webhook.event.id when the body has no id', () => {
    expect(checkNotificationAgainstEvent(arrivals('not json'), event, 'p1')?.message).toContain('webhook.event.id');
  });

  it('names loop.link when the link points elsewhere', () => {
    const error = checkNotificationAgainstEvent(arrivals(goodWebhook, '[Details](https://garage/project/p1/event/event-2/)'), event, 'p1');

    expect(error?.message).toContain('loop.link');
  });

  it('checks the webhook before the loop', () => {
    const error = checkNotificationAgainstEvent(arrivals('{}', 'nothing'), event, 'p1');

    expect(error?.message).toContain('webhook.event.id');
  });
});

/**
 * Posts a body to the threshold path of the receiver the way Hawk would.
 * @param parts Scenario with the receiver.
 * @param body Raw body.
 */
async function postThreshold(parts: NotificationTestScenario, body: string): Promise<void> {
  const response = await fetch(`${parts.address.baseUrl}/hooks/threshold/${TEST_RECEIVER_SECRET}`, { method: 'POST',
    headers: Object.fromEntries([['user-agent', 'Hawk-Webhook/1.0'], ['x-hawk-notification', 'event']]),
    body });

  await response.arrayBuffer();
}

/**
 * Builds a threshold webhook body for the run of a scenario.
 * @param parts Scenario with the plan.
 * @param repetitionId Id of the repetition, null for the first event.
 * @returns JSON text of the body.
 */
function thresholdBody(parts: NotificationTestScenario, repetitionId: string | null): string {
  return JSON.stringify({ type: 'event',
    payload: { project: { id: parts.context.config.hawk.projectId },
      events: [{ event: { id: 'e1',
        title: parts.plan.title },
      repetitionId }] } });
}

/**
 * Runs the stages of a repeat run up to the threshold stage: send, search, notification, repeat.
 * @param parts Scenario built with `repeat: true`.
 * @returns Results of the repeat stage and the threshold stage.
 */
async function repeatAndThreshold(parts: NotificationTestScenario): Promise<[StageResult, StageResult]> {
  const { context } = parts;

  await sendEvent(context);
  await run(eventVisibleStage(TIMEOUT_MS), context);
  await run(notificationFormedStage(FORMED_TIMEOUT_MS), context);

  const repeated = await run(eventRepeatedStage(TIMEOUT_MS, thresholdBeforeRepeat(context)), context);
  const formed = await run(thresholdFormedStage(FORMED_TIMEOUT_MS), context);

  return [repeated, formed];
}

describe('thresholdFormedStage', () => {
  it('is ok when the repeat makes Hawk send the threshold notification, and times it from the repeat', async () => {
    const parts = await scenario({ repeat: true });
    const [repeated, formed] = await repeatAndThreshold(parts);

    expect(repeated.status).toBe('ok');
    expect(formed.status).toBe('ok');
    expect(formed.details?.latencyMs).toBeTypeOf('number');
    expect(parts.context.state.repeatAcceptedAtMs).toBeTypeOf('number');
    expect(parts.receiver.counts(parts.plan.runId).threshold).toHaveLength(1);
  });

  it('is skipped when the run does not repeat', async () => {
    const parts = await scenario({ repeat: false });

    await sendEvent(parts.context);

    expect(await run(thresholdFormedStage(FORMED_TIMEOUT_MS), parts.context)).toMatchObject({ status: 'skipped' });
  });

  it('is skipped while the rule cache may still hold the old rules', async () => {
    const parts = await scenario({ repeat: true });

    parts.context.notification.warmup = true;
    parts.context.notification.ruleChangedAgoMs = 1000;

    const result = await run(thresholdFormedStage(FORMED_TIMEOUT_MS), parts.context);

    expect(result).toMatchObject({ status: 'skipped',
      details: { reason: 'rule_cache_warmup' } });
  });

  it('fails with threshold_early when a threshold POST came before the repeat', async () => {
    const parts = await scenario({ repeat: true });
    const { context } = parts;

    await sendEvent(context);
    await run(eventVisibleStage(TIMEOUT_MS), context);
    await postThreshold(parts, thresholdBody(parts, null));
    await vi.waitFor(() => {
      expect(parts.receiver.counts(parts.plan.runId).threshold).toHaveLength(1);
    });
    await run(eventRepeatedStage(TIMEOUT_MS, thresholdBeforeRepeat(context)), context);

    const result = await run(thresholdFormedStage(FORMED_TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'threshold_early',
      culprit: 'hawk' });
  });

  it('fails with threshold_early when the POST that comes after the repeat has no repetition id', async () => {
    const parts = await scenario({ repeat: true });

    hawk.rules.remove(hawk.projectId, hawk.rules.list(hawk.projectId).find(rule => rule.whatToReceive === 'SEEN_MORE' && rule.including.length === 1)?.id ?? '');

    const { context } = parts;

    await sendEvent(context);
    await run(eventVisibleStage(TIMEOUT_MS), context);
    await run(eventRepeatedStage(TIMEOUT_MS, thresholdBeforeRepeat(context)), context);
    await postThreshold(parts, thresholdBody(parts, null));

    expect(await run(thresholdFormedStage(FORMED_TIMEOUT_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'threshold_early' });
  });

  it('fails with notification_timeout for the threshold channel when nothing arrives', async () => {
    const parts = await scenario({ repeat: true,
      env: { NOTIFICATION_TIMEOUT_MS: '300',
        NOTIFICATION_PAIR_WAIT_MS: '100' } });

    hawk.rules.remove(hawk.projectId, hawk.rules.list(hawk.projectId).find(rule => rule.whatToReceive === 'SEEN_MORE' && rule.including.length === 1)?.id ?? '');

    const { context } = parts;

    await sendEvent(context);
    await run(eventVisibleStage(TIMEOUT_MS), context);
    await run(eventRepeatedStage(TIMEOUT_MS, thresholdBeforeRepeat(context)), context);

    const result = await run(thresholdFormedStage(FORMED_TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'notification_timeout',
      culprit: 'hawk' });
    expect(result.message).toContain('threshold');
  });

  it('fails with notification_mismatch for a body about another project', async () => {
    const parts = await scenario({ repeat: true });

    hawk.rules.remove(hawk.projectId, hawk.rules.list(hawk.projectId).find(rule => rule.whatToReceive === 'SEEN_MORE' && rule.including.length === 1)?.id ?? '');

    const { context } = parts;

    await sendEvent(context);
    await run(eventVisibleStage(TIMEOUT_MS), context);
    await run(eventRepeatedStage(TIMEOUT_MS, thresholdBeforeRepeat(context)), context);
    await postThreshold(parts, thresholdBody(parts, 'rep1').replace(parts.context.config.hawk.projectId, 'other'));

    expect(await run(thresholdFormedStage(FORMED_TIMEOUT_MS), context)).toMatchObject({ status: 'failed',
      errorClass: 'notification_mismatch' });
  });
});
