import type { ChannelSettings, NotificationChannel, NotificationRule } from '../../../src/notifications/types.js';
import type { FakeRules } from './rules.js';
import type { FakeStore, StoredEvent } from './store.js';

const SEND_TIMEOUT_MS = 10_000;
const CHANNELS: readonly NotificationChannel[] = ['webhook', 'loop'];
const WEBHOOK_PERIOD = 60;

/** How a test breaks the notifier or one of its senders. */
export interface FakeNotifierKnobs {
  /** The notifier does not react to events at all. */
  off?: boolean;
  /** The webhook sender is not running. */
  webhookOff?: boolean;
  /** The loop sender is not running. */
  loopOff?: boolean;
  /** Pause before every send, in real time; a record sets it by channel. */
  delayMs?: number | Partial<Record<NotificationChannel, number>>;
  /** Sends a channel twice; the second send waits for `after` when it is given. */
  duplicate?: DuplicateKnob;
  /** Rewrites a copy of the webhook body; the result is sent as JSON. */
  mutateWebhookBody?: (body: Record<string, unknown>) => unknown;
  /** Sends this text as the webhook body, as it is. */
  webhookRawBody?: string;
  /** Replaces all headers of the webhook. */
  webhookHeaders?: Record<string, string>;
  /** How long the notifier keeps the rules it read, counted from the read; 0 reads them every time. */
  ruleCacheMs?: number;
}

/** A channel that is sent twice. */
export interface DuplicateKnob {
  /** Channel to send twice. */
  channel: NotificationChannel;
  /** The second send starts when this resolves; right after the first one when absent. */
  after?: () => Promise<void>;
}

/** One send the notifier attempted. */
export interface SentRecord {
  /** Channel of the send. */
  channel: NotificationChannel;
  /** Address the request went to. */
  url: string;
  /** HTTP status, or `'error'` when there was no answer or the loop sender failed. */
  status: number | 'error';
}

/** A fake Hawk notifier with the webhook and loop senders. */
export interface FakeNotifier {
  /** Mutable switches. */
  readonly knobs: FakeNotifierKnobs;
  /** Every send attempt in order. */
  readonly sent: SentRecord[];
  /**
   * Waits for the webhook of an event.
   * @param eventId Id of the original event.
   * @returns Resolves after the first answer or failure of the webhook request, or when the notifier decides not to send one.
   */
  delivered(eventId: string): Promise<void>;
  /**
   * Waits until no decision or send is pending.
   * @returns Resolves at once when nothing is pending.
   */
  idle(): Promise<void>;
  /**
   * Stops listening, cancels delayed and running sends.
   * @returns Resolves when the notifier is stopped.
   */
  close(): Promise<void>;
}

/** What the notifier needs to know about its Hawk. */
export interface FakeNotifierOptions {
  /** Store the grouper writes to. */
  store: FakeStore;
  /** Rules of the projects. */
  rules: FakeRules;
  /** The only project the notifier serves. */
  projectId: string;
  /** Project name shown in webhook bodies. */
  projectName: string;
  /** Workspace id shown in webhook bodies. */
  workspaceId: string;
  /** Garage address in loop links. */
  garageUrl: string;
  /** Time source of the rule cache, ms; `Date.now` by default. */
  now?: () => number;
}

/** A promise that something else resolves. */
interface Deferred {
  /** The promise handed to waiters. */
  promise: Promise<void>;
  /** Resolves it. */
  resolve: () => void;
}

/** Rules read at some moment. */
interface CachedRules {
  /** The rules. */
  rules: NotificationRule[];
  /** Time of the read. */
  filledAt: number;
}

/** Holder of a timer that its own callback has to clear. */
interface TimerHandle {
  /** The running timer. */
  handle?: NodeJS.Timeout;
}

/**
 * Creates a promise with an outside resolver.
 * @returns Promise and its resolver.
 */
function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise,
    resolve };
}

/**
 * Reads the title the way the sender shows it.
 * @param event Stored event.
 * @returns The title, or `Unknown` as in Hawk.
 */
function titleOf(event: StoredEvent): string {
  const { title } = event.payload;

  return typeof title === 'string' && title !== '' ? title : 'Unknown';
}

/**
 * Reads the backtrace frames of an event.
 * @param event Stored event.
 * @returns Frames as objects, empty when there is none.
 */
function framesOf(event: StoredEvent): Array<Record<string, unknown>> {
  const { backtrace } = event.payload;

  return Array.isArray(backtrace) ? backtrace.filter((frame): frame is Record<string, unknown> => typeof frame === 'object' && frame !== null) : [];
}

/**
 * Checks a rule the way the notifier worker does.
 * @param rule Rule to check.
 * @param title Event title.
 * @param isNew Whether the event started a new group.
 * @returns True when the rule asks for this event.
 */
function matches(rule: NotificationRule, title: string, isNew: boolean): boolean {
  if (!rule.isEnabled || (rule.whatToReceive === 'ONLY_NEW' && !isNew)) {
    return false;
  }

  if (rule.including.length > 0 && !rule.including.some(word => title.includes(word))) {
    return false;
  }

  return !rule.excluding.some(word => title.toLowerCase().includes(word.toLowerCase()));
}

/**
 * Starts a notifier that listens to the store.
 * @param options Store, rules and the facts that go into messages.
 * @returns The running notifier.
 */
export function startFakeNotifier(options: FakeNotifierOptions): FakeNotifier {
  const { store, rules, projectId } = options;
  const now = options.now ?? Date.now;
  const knobs: FakeNotifierKnobs = {};
  const sent: SentRecord[] = [];
  const cache = new Map<string, CachedRules>();
  const deliveries = new Map<string, Deferred>();
  const sleepers = new Set<() => void>();
  const idleWaiters: Array<() => void> = [];
  const stop = new AbortController();
  let pending = 0;
  let closed = false;

  const deliveryOf = (eventId: string): Deferred => {
    let delivery = deliveries.get(eventId);

    if (!delivery) {
      delivery = deferred();
      deliveries.set(eventId, delivery);
    }

    return delivery;
  };
  const flushIdle = (): void => {
    for (const resolve of idleWaiters.splice(0)) {
      resolve();
    }
  };
  const begin = (): void => {
    pending += 1;
  };
  const end = (): void => {
    if (closed) {
      return;
    }

    pending -= 1;

    if (pending === 0) {
      flushIdle();
    }
  };
  const sleep = async (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const timer: TimerHandle = {};
    const wake = (): void => {
      clearTimeout(timer.handle);
      sleepers.delete(wake);
      resolve();
    };

    timer.handle = setTimeout(wake, ms);
    sleepers.add(wake);
  });
  const rulesOfProject = (): NotificationRule[] => {
    const ttl = knobs.ruleCacheMs ?? 0;
    const cached = cache.get(projectId);

    if (ttl > 0 && cached && now() - cached.filledAt < ttl) {
      return cached.rules;
    }

    const fresh = rules.list(projectId);

    if (ttl > 0) {
      cache.set(projectId, { rules: fresh,
        filledAt: now() });
    }

    return fresh;
  };

  const post = async (channel: NotificationChannel, url: string, headers: Record<string, string>, body: string): Promise<void> => {
    let status: number | 'error';

    try {
      const response = await fetch(url, { method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.any([stop.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) });

      status = response.status;
      await response.body?.cancel();
    } catch {
      status = 'error';
    }

    if (!closed) {
      sent.push({ channel,
        url,
        status });
    }
  };

  const sendWebhook = async (url: string, event: StoredEvent): Promise<void> => {
    const { payload } = event;
    let body: string;
    let headers: Record<string, string> = Object.fromEntries([
      ['Content-Type', 'application/json'],
      ['User-Agent', 'Hawk-Webhook/1.0'],
      ['X-Hawk-Notification', 'event'],
    ]);

    if (knobs.webhookRawBody === undefined) {
      const full: Record<string, unknown> = {
        type: 'event',
        payload: {
          project: { id: projectId,
            name: options.projectName,
            workspaceId: options.workspaceId,
            image: null },
          events: [{
            event: { id: event.id,
              groupHash: event.groupHash,
              totalCount: event.totalCount,
              catcherType: event.catcherType,
              timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Math.floor(Date.now() / 1000),
              usersAffected: 0,
              title: titleOf(event),
              type: payload.type ?? null,
              backtrace: framesOf(event).map(frame => ({ file: frame.file,
                line: frame.line,
                column: frame.column ?? null,
                function: frame.function ?? null })) },
            newCount: 1,
            daysRepeated: 1,
            usersAffected: null,
            repetitionId: null,
          }],
          period: WEBHOOK_PERIOD,
        },
      };

      body = JSON.stringify(knobs.mutateWebhookBody ? knobs.mutateWebhookBody(structuredClone(full)) : full);
    } else {
      body = knobs.webhookRawBody;
    }

    if (knobs.webhookHeaders) {
      headers = { ...knobs.webhookHeaders };
    }

    await post('webhook', url, headers, body);
  };

  const sendLoop = async (url: string, event: StoredEvent): Promise<void> => {
    const frames = framesOf(event);

    // The loop template reads the backtrace without a check and fails, so the sender sends nothing.
    if (frames.length === 0) {
      sent.push({ channel: 'loop',
        url,
        status: 'error' });

      return;
    }

    const link = `${options.garageUrl}/project/${projectId}/event/${event.id}/`;
    const text = `**${titleOf(event)}**\n*${String(frames[0]?.file)}*\n[Details](${link}) | *${options.projectName}*`;

    await post('loop', url, Object.fromEntries([['Content-Type', 'application/json']]), JSON.stringify({ username: 'Hawk',
      text }));
  };

  /**
   * One sender job: what the sender worker does for one rule and channel.
   * @param channel Sender to run.
   * @param ruleId Rule the job came from.
   * @param eventId Original event id.
   */
  const perform = async (channel: NotificationChannel, ruleId: string, eventId: string): Promise<void> => {
    const { delayMs } = knobs;
    const pause = typeof delayMs === 'object' ? delayMs[channel] : delayMs;

    if (pause !== undefined && pause > 0) {
      await sleep(pause);
    }

    if (closed) {
      return;
    }

    // The sender reads the rule from the database on every job, so the address is never the cached one.
    const settings: ChannelSettings | null | undefined = rules.list(projectId).find(rule => rule.id === ruleId)?.channels[channel];
    const event = store.get(projectId, eventId);

    if (!settings || settings.endpoint === '' || !event) {
      if (channel === 'webhook') {
        deliveryOf(eventId).resolve();
      }

      return;
    }

    const send = channel === 'webhook' ? sendWebhook : sendLoop;

    await send(settings.endpoint, event);

    if (channel === 'webhook') {
      deliveryOf(eventId).resolve();
    }

    if (knobs.duplicate?.channel === channel) {
      await knobs.duplicate.after?.();

      if (!closed) {
        await send(settings.endpoint, event);
      }
    }
  };

  const unsubscribe = store.subscribe((eventProject, event, isNew) => {
    if (eventProject !== projectId || knobs.off === true) {
      deliveryOf(event.id).resolve();

      return;
    }

    const title = titleOf(event);
    let webhookJobs = 0;

    for (const rule of rulesOfProject().filter(candidate => matches(candidate, title, isNew))) {
      for (const channel of CHANNELS) {
        const switchedOff = channel === 'webhook' ? knobs.webhookOff === true : knobs.loopOff === true;

        if (rule.channels[channel]?.isEnabled !== true || switchedOff) {
          continue;
        }

        webhookJobs += channel === 'webhook' ? 1 : 0;
        begin();
        perform(channel, rule.id, event.id).catch(() => undefined)
          .finally(end);
      }
    }

    if (webhookJobs === 0) {
      deliveryOf(event.id).resolve();
    }
  });

  const idle: FakeNotifier['idle'] = async () => {
    if (pending === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  };

  const close: FakeNotifier['close'] = () => {
    closed = true;
    unsubscribe();
    stop.abort();

    for (const wake of [...sleepers]) {
      wake();
    }

    for (const delivery of deliveries.values()) {
      delivery.resolve();
    }

    pending = 0;
    flushIdle();

    return Promise.resolve();
  };

  return {
    knobs,
    sent,
    delivered: async eventId => deliveryOf(eventId).promise,
    idle,
    close,
  };
}
