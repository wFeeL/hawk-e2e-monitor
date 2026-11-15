import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { NotificationRule } from '../../../src/notifications/types.js';
import { startFakeHawk } from './index.js';
import type { FakeHawk } from './index.js';
import { startFakeNotifier } from './notifier.js';
import type { FakeNotifier } from './notifier.js';
import { createFakeRules } from './rules.js';
import type { FakeRules } from './rules.js';
import { createFakeStore } from './store.js';
import type { FakeStore, StoredEvent } from './store.js';

const PROJECT = 'a'.repeat(24);
const OTHER_PROJECT = 'b'.repeat(24);
const TITLE = '[e2e:t] rabc check-notification';
const GARAGE = 'http://garage.test';
const BACKTRACE = [{ file: 'hawk-e2e-monitor/check.js',
  line: 1,
  column: 1,
  function: 'check' }];

/** One request the test receiver saw. */
interface Received {
  /** Path with the query. */
  path: string;
  /** Request headers, names in lower case. */
  headers: IncomingHttpHeaders;
  /** Body text. */
  body: string;
}

/** HTTP server standing in for the monitor's receiver. */
interface Receiver {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** Requests in arrival order. */
  requests: Received[];
  /** Answers every request when set; 200 otherwise. */
  respond?: (request: IncomingMessage, response: ServerResponse) => void;
  /**
   * Resolves when at least `count` requests have arrived.
   * @param count How many requests to wait for.
   * @returns Resolves on arrival.
   */
  waitFor(count: number): Promise<void>;
  /**
   * Stops the server.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

/** Everything a test builds. */
interface Harness {
  /** Store the notifier listens to. */
  store: FakeStore;
  /** Rules of the project. */
  rules: FakeRules;
  /** Receiver of the webhook and loop requests. */
  receiver: Receiver;
  /** Notifier under test. */
  notifier: FakeNotifier;
  /** Fake time the rule cache reads. */
  time: FakeTime;
  /** The rule created by `setup`, absent when it was asked for none. */
  rule: NotificationRule | undefined;
}

/** Time the rule cache reads, set by the test. */
interface FakeTime {
  /** Current time, ms. */
  value: number;
}

/** A part of a rule input the tests change. */
interface RuleExtra {
  /** Other input fields. */
  [key: string]: unknown;
}

const receivers: Receiver[] = [];
const notifiers: FakeNotifier[] = [];
const hawks: FakeHawk[] = [];

/**
 * Starts a receiver on a random port.
 * @returns Receiver; stopped in afterEach.
 */
async function startReceiver(): Promise<Receiver> {
  const waiting: Array<[number, () => void]> = [];
  const requests: Received[] = [];
  const receiver: Receiver = { url: '',
    requests,
    waitFor: async (count) => {
      if (requests.length >= count) {
        return;
      }

      await new Promise<void>((resolve) => {
        waiting.push([count, resolve]);
      });
    },
    close: () => Promise.resolve() };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8') });

      for (const [count, resolve] of waiting) {
        if (requests.length >= count) {
          resolve();
        }
      }

      if (receiver.respond) {
        receiver.respond(request, response);
      } else {
        response.statusCode = 200;
        response.end('ok');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  receiver.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  receiver.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
  receivers.push(receiver);

  return receiver;
}

/**
 * Builds the input of a rule that points both channels at the receiver.
 * @param receiver Receiver of the notifications.
 * @param extra Fields that replace the defaults.
 * @returns Input of `rules.create` and `rules.update`.
 */
function ruleInput(receiver: Receiver, extra: RuleExtra = {}): Record<string, unknown> {
  const off = { isEnabled: false,
    endpoint: '' };

  return { projectId: PROJECT,
    including: ['[e2e:t]'],
    excluding: ['send-and-receive-event'],
    channels: { email: off,
      slack: off,
      telegram: off,
      loop: { endpoint: `${receiver.url}/hooks/loop/s` },
      webhook: { endpoint: `${receiver.url}/hooks/webhook/s` } },
    ...extra };
}

/**
 * Takes the rule out of a creation result.
 * @param result What `rules.create` returned.
 * @returns The rule, or a thrown failure for an error.
 */
function created(result: ReturnType<FakeRules['create']>): NotificationRule {
  if ('code' in result) {
    throw new Error(result.message);
  }

  return result;
}

/**
 * Builds the world of a test: store, rules, receiver, notifier and a rule for the receiver.
 * @param extra Fields of the first rule that replace the defaults; null creates no rule.
 * @returns The parts and the rule.
 */
async function setup(extra: RuleExtra | null = {}): Promise<Harness> {
  const store = createFakeStore();
  const rules = createFakeRules({ allowPrivateWebhook: () => true,
    resolves: () => true });
  const receiver = await startReceiver();
  const time = { value: 0 };
  const notifier = startFakeNotifier({ store,
    rules,
    projectId: PROJECT,
    projectName: 'Fake project',
    workspaceId: 'ws1',
    garageUrl: GARAGE,
    now: () => time.value });

  notifiers.push(notifier);

  return { store,
    rules,
    receiver,
    notifier,
    time,
    rule: extra === null ? undefined : created(rules.create(PROJECT, ruleInput(receiver, extra))) };
}

/**
 * Stores an event with a backtrace, as the monitor sends it.
 * @param store Store to write to.
 * @param title Event title.
 * @param projectId Project of the event.
 * @param payload Fields that replace the defaults.
 * @returns The stored event.
 */
function ingest(store: FakeStore, title = TITLE, projectId = PROJECT, payload: Record<string, unknown> = {}): StoredEvent {
  return store.ingest(projectId, 'errors/nodejs', { title,
    type: 'e2e-check',
    context: {},
    backtrace: BACKTRACE,
    ...payload });
}

/**
 * Requests of one channel.
 * @param receiver Receiver that saw them.
 * @param channel Path part: `webhook` or `loop`.
 * @returns Requests whose path names the channel.
 */
function of(receiver: Receiver, channel: string): Received[] {
  return receiver.requests.filter(request => request.path.includes(`/hooks/${channel}/`));
}

/**
 * Parses a received body.
 * @param request Received request.
 * @returns Parsed JSON object.
 */
function json(request: Received | undefined): Record<string, unknown> {
  return JSON.parse(request?.body ?? 'null') as Record<string, unknown>;
}

/** The payload of a webhook body as the tests read it. */
interface WebhookPayload {
  /** Events of the notification. */
  events: Array<Record<string, unknown>>;
}

afterEach(async () => {
  await Promise.all(notifiers.splice(0).map(async notifier => notifier.close()));
  await Promise.all(hawks.splice(0).map(async hawk => hawk.close()));
  await Promise.all(receivers.splice(0).map(async receiver => receiver.close()));
});

describe('fake notifier senders', () => {
  it('webhook arrives with Hawk headers and body', async () => {
    const { store, receiver, notifier } = await setup();
    const event = ingest(store);

    await notifier.delivered(event.id);

    const [request] = of(receiver, 'webhook');

    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['user-agent']).toBe('Hawk-Webhook/1.0');
    expect(request?.headers['x-hawk-notification']).toBe('event');
    expect(json(request)).toEqual({
      type: 'event',
      payload: {
        project: { id: PROJECT,
          name: 'Fake project',
          workspaceId: 'ws1',
          image: null },
        events: [{
          event: { id: event.id,
            groupHash: event.groupHash,
            totalCount: 1,
            catcherType: 'errors/nodejs',
            timestamp: expect.any(Number) as number,
            usersAffected: 0,
            title: TITLE,
            type: 'e2e-check',
            backtrace: BACKTRACE },
          newCount: 1,
          daysRepeated: 1,
          usersAffected: null,
          repetitionId: null,
        }],
        period: 60,
      },
    });
    expect(notifier.sent).toContainEqual({ channel: 'webhook',
      url: `${receiver.url}/hooks/webhook/s`,
      status: 200 });
  });

  it('loop arrives with title and event link', async () => {
    const { store, receiver, notifier } = await setup();
    const event = ingest(store);

    await notifier.idle();

    const [request] = of(receiver, 'loop');
    const body = json(request);

    expect(request?.headers['content-type']).toContain('application/json');
    expect(body.username).toBe('Hawk');
    expect(body.text).toContain(`**${TITLE}**`);
    expect(body.text).toContain(`${GARAGE}/project/${PROJECT}/event/${event.id}/`);
  });

  it('loop is not sent without backtrace, and the attempt is logged as an error', async () => {
    const { store, receiver, notifier } = await setup();

    ingest(store, TITLE, PROJECT, { backtrace: undefined });
    ingest(store, `${TITLE} two`, PROJECT, { backtrace: [] });
    await notifier.idle();

    expect(of(receiver, 'loop')).toEqual([]);
    expect(of(receiver, 'webhook')).toHaveLength(2);
    expect(notifier.sent.filter(entry => entry.channel === 'loop').map(entry => entry.status)).toEqual(['error', 'error']);
  });

  it('webhook backtrace is empty when the event has none', async () => {
    const { store, receiver, notifier } = await setup();

    ingest(store, TITLE, PROJECT, { backtrace: undefined });
    await notifier.idle();

    const event = ((json(of(receiver, 'webhook')[0]).payload as Record<string, unknown>).events as Array<Record<string, unknown>>)[0]?.event as Record<string, unknown>;

    expect(event.backtrace).toEqual([]);
    expect(event.type).toBe('e2e-check');
  });

  it('an unreachable address is an error entry and still counts as delivered', async () => {
    const { store, rules, receiver, notifier } = await setup(null);
    const dead = await startReceiver();
    const deadUrl = dead.url;

    await dead.close();
    rules.create(PROJECT, ruleInput(receiver, { channels: { email: { isEnabled: false,
      endpoint: '' },
    slack: { isEnabled: false,
      endpoint: '' },
    telegram: { isEnabled: false,
      endpoint: '' },
    loop: { isEnabled: false,
      endpoint: '' },
    webhook: { endpoint: `${deadUrl}/hooks/webhook/s` } } }));

    const event = ingest(store);

    await notifier.delivered(event.id);

    expect(notifier.sent).toEqual([{ channel: 'webhook',
      url: `${deadUrl}/hooks/webhook/s`,
      status: 'error' }]);
  });

  it('a redirect is not followed', async () => {
    const { store, receiver, notifier } = await setup();

    receiver.respond = (request, response) => {
      if (request.url?.includes('/hooks/webhook/') === true) {
        response.statusCode = 302;
        response.setHeader('location', `${receiver.url}/elsewhere`);
      }

      response.end();
    };
    ingest(store);
    await notifier.idle();

    expect(receiver.requests.some(request => request.path === '/elsewhere')).toBe(false);
    expect(notifier.sent.find(entry => entry.channel === 'webhook')?.status).not.toBe('error');
  });
});

describe('fake notifier rules', () => {
  it('ONLY_NEW ignores a repetition', async () => {
    const { store, receiver, notifier } = await setup();

    ingest(store);
    ingest(store);
    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(1);
    expect(of(receiver, 'loop')).toHaveLength(1);
  });

  it('a new-events rule tells repetitionId null', async () => {
    const { store, receiver, notifier } = await setup();
    const event = ingest(store);

    await notifier.delivered(event.id);

    const [request] = of(receiver, 'webhook');
    const [item] = (json(request).payload as WebhookPayload).events;

    expect(item?.repetitionId).toBeNull();
  });
});

describe('fake notifier threshold rule', () => {
  const THRESHOLD = { whatToReceive: 'SEEN_MORE',
    threshold: 2,
    thresholdPeriod: 3_600_000 };

  /**
   * Reads the repetition ids of the webhooks a receiver got.
   * @param receiver Receiver that saw them.
   * @returns One value per webhook.
   */
  function repetitionIds(receiver: Receiver): unknown[] {
    return of(receiver, 'webhook').map(request => (json(request).payload as WebhookPayload).events[0]?.repetitionId);
  }

  it('sends on the event that makes the count reach the threshold, and on no other', async () => {
    const { store, receiver, notifier } = await setup(THRESHOLD);

    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(0);

    const second = ingest(store);

    await notifier.idle();
    expect(repetitionIds(receiver)).toEqual([second.lastRepetitionId]);
    expect(second.lastRepetitionId).toEqual(expect.any(String));

    ingest(store);
    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('counts each group on its own', async () => {
    const { store, receiver, notifier } = await setup(THRESHOLD);

    ingest(store, '[e2e:t] one');
    ingest(store, '[e2e:t] two');
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(0);

    ingest(store, '[e2e:t] two');
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('starts the count again when the period has passed', async () => {
    const { store, receiver, notifier, time } = await setup(THRESHOLD);

    ingest(store);
    time.value = 3_600_000;
    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(0);

    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('keeps the count within the period', async () => {
    const { store, receiver, notifier, time } = await setup(THRESHOLD);

    ingest(store);
    time.value = 3_599_999;
    ingest(store);
    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('counts separately for each rule', async () => {
    const { store, receiver, notifier, rules } = await setup(THRESHOLD);

    created(rules.create(PROJECT, ruleInput(receiver, { ...THRESHOLD,
      threshold: 3 })));
    ingest(store);
    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(1);

    ingest(store);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(2);
  });

  it('fires a threshold rule on the first event when the knob says so, and then keeps counting', async () => {
    const { store, receiver, notifier } = await setup(THRESHOLD);

    notifier.knobs.fireThresholdOnFirst = true;
    ingest(store);
    await notifier.idle();
    expect(repetitionIds(receiver)).toEqual([null]);
  });

  it('a threshold of 1 fires on the first event, with no repetition id', async () => {
    const { store, receiver, notifier } = await setup({ ...THRESHOLD,
      threshold: 1 });

    ingest(store);
    await notifier.idle();

    expect(repetitionIds(receiver)).toEqual([null]);
  });
});

describe('fake notifier rule matching', () => {
  it('including is case sensitive, excluding is not', async () => {
    const { store, receiver, notifier } = await setup({ including: ['ABC'],
      excluding: ['SKIP'] });

    ingest(store, 'xx abc');
    ingest(store, 'xx ABC');
    ingest(store, 'xx ABC and skip this');
    await notifier.idle();

    expect(of(receiver, 'webhook').map(request => (json(request).payload as Record<string, unknown>).events)).toHaveLength(1);
    expect(JSON.stringify(json(of(receiver, 'webhook')[0]))).toContain('xx ABC');
  });

  it('one of several including words is enough and an empty list lets everything in', async () => {
    const { store, receiver, notifier } = await setup({ including: ['one', 'two'],
      excluding: [] });

    ingest(store, 'has two inside');
    ingest(store, 'has neither');
    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(1);

    const open = await setup({ including: [],
      excluding: [] });

    ingest(open.store, 'anything');
    await open.notifier.idle();

    expect(of(open.receiver, 'webhook')).toHaveLength(1);
  });

  it('send-and-receive-event title is excluded', async () => {
    const { store, receiver, notifier } = await setup();
    const event = ingest(store, '[e2e:t] rabc send-and-receive-event');

    await notifier.delivered(event.id);
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
  });

  it('a disabled rule and a disabled channel send nothing', async () => {
    const off = await setup({ isEnabled: false });

    ingest(off.store);
    await off.notifier.idle();

    expect(off.receiver.requests).toEqual([]);

    const { store, rules, receiver, notifier } = await setup(null);
    const input = ruleInput(receiver);
    const channels = input.channels as Record<string, unknown>;

    rules.create(PROJECT, { ...input,
      channels: { ...channels,
        webhook: { isEnabled: false,
          endpoint: `${receiver.url}/hooks/webhook/s` } } });
    ingest(store);
    await notifier.idle();

    expect(of(receiver, 'webhook')).toEqual([]);
    expect(of(receiver, 'loop')).toHaveLength(1);
  });

  it('the default rule of a project sends nothing: webhook null, loop off', async () => {
    const { store, rules, receiver, notifier } = await setup(null);

    rules.seed(PROJECT, { id: 'default',
      isEnabled: true,
      whatToReceive: 'SEEN_MORE',
      including: [],
      excluding: [],
      threshold: 20,
      thresholdPeriod: 3_600_000,
      channels: { email: { isEnabled: true,
        endpoint: 'me@example.com' },
      slack: { isEnabled: false,
        endpoint: '' },
      loop: { isEnabled: false,
        endpoint: '' },
      telegram: { isEnabled: false,
        endpoint: '' },
      webhook: null } });
    ingest(store);
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('events of another project are ignored', async () => {
    const { store, receiver, notifier } = await setup();

    ingest(store, TITLE, OTHER_PROJECT);
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
  });

  it('rule cache serves the old rule until ruleCacheMs passes', async () => {
    const { store, rules, receiver, notifier, time, rule } = await setup();
    const id = rule?.id ?? '';

    notifier.knobs.ruleCacheMs = 1000;
    ingest(store, `${TITLE} one`);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(1);

    rules.update(PROJECT, { ...ruleInput(receiver, { isEnabled: false }),
      ruleId: id });
    time.value = 999;
    ingest(store, `${TITLE} two`);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(2);

    time.value = 1000;
    ingest(store, `${TITLE} three`);
    await notifier.idle();
    expect(of(receiver, 'webhook')).toHaveLength(2);
  });

  it('without ruleCacheMs every event reads the rules anew', async () => {
    const { store, rules, receiver, notifier, rule } = await setup();

    ingest(store, `${TITLE} one`);
    await notifier.idle();
    rules.update(PROJECT, { ...ruleInput(receiver, { isEnabled: false }),
      ruleId: rule?.id ?? '' });
    ingest(store, `${TITLE} two`);
    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('endpoint is read fresh even with a cached rule', async () => {
    const { store, rules, receiver, notifier, rule } = await setup();
    const input = ruleInput(receiver);
    const channels = input.channels as Record<string, unknown>;

    notifier.knobs.ruleCacheMs = 1000;
    ingest(store, `${TITLE} one`);
    await notifier.idle();
    rules.update(PROJECT, { ...input,
      ruleId: rule?.id ?? '',
      channels: { ...channels,
        webhook: { endpoint: `${receiver.url}/hooks/webhook/new` } } });
    ingest(store, `${TITLE} two`);
    await notifier.idle();

    expect(of(receiver, 'webhook').map(request => request.path)).toEqual(['/hooks/webhook/s', '/hooks/webhook/new']);
  });

  it('a rule deleted after the match sends nothing', async () => {
    const { store, rules, receiver, notifier, rule } = await setup();

    notifier.knobs.ruleCacheMs = 1000;
    notifier.knobs.delayMs = 5;
    ingest(store, `${TITLE} one`);
    rules.remove(PROJECT, rule?.id ?? '');
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
  });
});

describe('fake notifier knobs', () => {
  it('off sends nothing, webhookOff and loopOff each switch one sender', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.off = true;
    ingest(store, `${TITLE} a`);
    await notifier.idle();
    expect(receiver.requests).toEqual([]);

    notifier.knobs.off = false;
    notifier.knobs.webhookOff = true;
    ingest(store, `${TITLE} b`);
    await notifier.idle();
    expect(receiver.requests.map(request => request.path)).toEqual(['/hooks/loop/s']);

    notifier.knobs.webhookOff = false;
    notifier.knobs.loopOff = true;
    ingest(store, `${TITLE} c`);
    await notifier.idle();
    expect(receiver.requests.map(request => request.path)).toEqual(['/hooks/loop/s', '/hooks/webhook/s']);
  });

  it('delivered resolves also when nothing is sent', async () => {
    const { store, notifier } = await setup();

    notifier.knobs.off = true;

    await notifier.delivered(ingest(store).id);

    const second = await setup({ isEnabled: false });

    await second.notifier.delivered(ingest(second.store).id);
  });

  it('delivered can be awaited twice and also before the event arrives', async () => {
    const { store, notifier } = await setup({ isEnabled: false });
    const early = notifier.delivered('0'.repeat(24));
    const event = ingest(store);

    await notifier.delivered(event.id);
    await notifier.delivered(event.id);

    expect(early).toBeInstanceOf(Promise);
  });

  it('idle resolves at once when nothing is pending', async () => {
    const { notifier } = await setup();

    await notifier.idle();
  });

  it('delayMs puts the send off, idle waits for it', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.delayMs = 15;
    ingest(store);

    expect(receiver.requests).toEqual([]);

    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(1);
  });

  it('delayMs can differ by channel', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.delayMs = { loop: 300 };

    const event = ingest(store);

    await notifier.delivered(event.id);

    expect(of(receiver, 'webhook')).toHaveLength(1);
    expect(of(receiver, 'loop')).toEqual([]);

    await notifier.idle();

    expect(of(receiver, 'loop')).toHaveLength(1);
  });

  it('a removed event is not sent', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.delayMs = 10;

    const event = ingest(store);

    store.remove(PROJECT, event.id);
    await notifier.delivered(event.id);
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('close drops delayed sends and lets idle resolve', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.delayMs = 60_000;
    ingest(store);
    await notifier.close();
    await notifier.idle();

    expect(receiver.requests).toEqual([]);

    ingest(store, `${TITLE} after close`);
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
  });

  it('duplicate sends the channel twice', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.duplicate = { channel: 'webhook' };
    ingest(store);
    await notifier.idle();

    expect(of(receiver, 'webhook')).toHaveLength(2);
    expect(of(receiver, 'loop')).toHaveLength(1);
  });

  it('duplicate.after holds the second send until it resolves', async () => {
    const { store, receiver, notifier } = await setup();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    notifier.knobs.duplicate = { channel: 'loop',
      after: async () => gate };

    const event = ingest(store);

    await notifier.delivered(event.id);
    await receiver.waitFor(2);

    expect(of(receiver, 'loop')).toHaveLength(1);

    release();
    await notifier.idle();

    expect(of(receiver, 'loop')).toHaveLength(2);
  });

  it('mutateWebhookBody changes the body and webhookRawBody replaces it', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.mutateWebhookBody = body => ({ ...body,
      type: 'mangled' });
    ingest(store, `${TITLE} a`);
    await notifier.idle();
    expect(json(of(receiver, 'webhook')[0]).type).toBe('mangled');

    notifier.knobs.webhookRawBody = 'not json at all';
    ingest(store, `${TITLE} b`);
    await notifier.idle();
    expect(of(receiver, 'webhook')[1]?.body).toBe('not json at all');
  });

  it('webhookHeaders replaces the Hawk headers', async () => {
    const { store, receiver, notifier } = await setup();

    notifier.knobs.webhookHeaders = Object.fromEntries([['X-Other', 'yes']]);
    ingest(store);
    await notifier.idle();

    const [request] = of(receiver, 'webhook');

    expect(request?.headers['x-other']).toBe('yes');
    expect(request?.headers['x-hawk-notification']).toBeUndefined();
    expect(request?.headers['user-agent']).not.toBe('Hawk-Webhook/1.0');
  });
});

describe('fake hawk with the notifier', () => {
  it('holdReply delays the collector answer until delivered', async () => {
    const hawk = await startFakeHawk();
    const receiver = await startReceiver();
    const log: string[] = [];

    hawks.push(hawk);
    hawk.rules.create(hawk.projectId, { ...ruleInput(receiver),
      projectId: hawk.projectId });
    receiver.respond = (request, response) => {
      response.statusCode = 200;
      response.end('ok');

      if (request.url?.includes('/hooks/webhook/') === true) {
        log.push('webhook answered');
      }
    };
    hawk.collector.knobs.holdReply = async (event) => {
      if (event) {
        await hawk.notifier.delivered(event.id);
      }
    };

    const reply = await fetch(hawk.collector.url, { method: 'POST',
      body: JSON.stringify({ token: hawk.token,
        catcherType: 'errors/nodejs',
        payload: { title: TITLE,
          backtrace: BACKTRACE } }) });

    log.push(`collector answered ${String(reply.status)}`);

    expect(log).toEqual(['webhook answered', 'collector answered 200']);
    expect(hawk.notifier.sent.map(entry => entry.channel)).toContain('webhook');
  });

  it('the default rule of the project makes no sends', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);
    hawk.store.ingest(hawk.projectId, 'errors/nodejs', { title: TITLE,
      backtrace: BACKTRACE });
    await hawk.notifier.idle();

    expect(hawk.notifier.sent).toEqual([]);
  });
});

describe('fake notifier telegram sender', () => {
  const NOTIFY = 'https://notify.bot.codex.so/u/abc123';

  /**
   * Builds a world whose rule sends to Telegram only, with the Telegram worker pointed at the test receiver.
   * @returns The parts of the test.
   */
  async function telegramWorld(): Promise<Harness> {
    const world = await setup(null);
    const off = { isEnabled: false,
      endpoint: '' };

    created(world.rules.create(PROJECT, { projectId: PROJECT,
      including: ['[e2e:t]'],
      excluding: [],
      channels: { email: off,
        slack: off,
        loop: off,
        telegram: { endpoint: NOTIFY },
        webhook: off } }));
    world.notifier.knobs.codexNotifyBase = world.receiver.url;

    return world;
  }

  /**
   * Reads the form the worker posted.
   * @param request Received request.
   * @returns Decoded form fields.
   */
  function form(request: Received | undefined): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(request?.body ?? ''));
  }

  it('posts the template of the Telegram worker with the Markdown parse mode', async () => {
    const { store, receiver, notifier } = await telegramWorld();
    const event = ingest(store, '[e2e:t] rabc telegram_delivery');

    await notifier.idle();

    const [request] = receiver.requests;
    const fields = form(request);

    expect(request?.path).toBe('/u/abc123');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(fields.parse_mode).toBe('Markdown');
    expect(fields.message).toBe([
      String.raw`\[e2e:t] rabc telegram\_delivery`,
      '',
      '```',
      'hawk-e2e-monitor/check.js',
      '```',
      `[View details](${GARAGE}/project/${PROJECT}/event/${event.id}/) | Fake project | 1 new (1 total)`,
    ].join('\n'));
    expect(notifier.sent).toContainEqual({ channel: 'telegram',
      url: `${receiver.url}/u/abc123`,
      status: 200 });
  });

  it('an ONLY_NEW Telegram rule does not send a repetition', async () => {
    const { store, receiver, notifier } = await telegramWorld();

    ingest(store, '[e2e:t] rabc check');
    ingest(store, '[e2e:t] rabc check');
    await notifier.idle();

    // The rule is ONLY_NEW, so a repetition sends nothing.
    expect(receiver.requests).toHaveLength(1);
  });

  it('leaves the code block out of an event without a backtrace', async () => {
    const { store, receiver, notifier } = await telegramWorld();

    ingest(store, '[e2e:t] rabc nobacktrace', PROJECT, { backtrace: [] });
    await notifier.idle();

    expect(form(receiver.requests[0]).message?.split('\n')).toEqual([
      '\\[e2e:t] rabc nobacktrace',
      '',
      expect.stringContaining('[View details]('),
    ]);
  });

  it('telegramWorkerDown drops the task', async () => {
    const { store, receiver, notifier } = await telegramWorld();

    notifier.knobs.telegramWorkerDown = true;
    ingest(store, '[e2e:t] rabc down');
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('sends nothing out of the machine without a stand-in, and logs an error', async () => {
    const { store, receiver, notifier } = await telegramWorld();

    notifier.knobs.codexNotifyBase = undefined;
    ingest(store, '[e2e:t] rabc nostandin');
    await notifier.idle();

    expect(receiver.requests).toEqual([]);
    expect(notifier.sent).toEqual([{ channel: 'telegram',
      url: NOTIFY,
      status: 'error' }]);
  });
});
