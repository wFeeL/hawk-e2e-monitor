import { formatDuration } from '../../time/format.js';
import type { FoundEvent } from '../../clients/hawk-api.js';
import type { notificationSettings } from '../../config/load.js';
import type { StageDetails } from '../../engine/result.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError, isCheckError } from '../../errors/taxonomy.js';
import { probeReceiver } from '../../notifications/address.js';
import type { PublicAddress } from '../../notifications/address.js';
import type { ProvisionResult, Provisioner } from '../../notifications/provisioning.js';
import type { ArrivalKind, NotificationChannel } from '../../notifications/types.js';
import type { Arrival, Arrivals, Receiver } from '../../receiver/server.js';
import type { ScenarioContext } from '../shared/context.js';
import { MS_PER_SECOND } from '../../time/units.js';

const DEFAULT_ADDRESS_POLL_MS = 2000;
const WEBHOOK_AGENT = 'Hawk-Webhook/1.0';
const WEBHOOK_KIND = 'event';

/** What the notification stages learn on the way and hand to the verdict. */
export interface NotificationState {
  /** What the receiver had when the wait of `notification_formed` ended. */
  arrivals?: Arrivals;
  /** What the receiver had after cleanup; the verdict reads late and repeated posts here. */
  finalArrivals?: Arrivals;
  /** True when the rule changed so recently that the notifier may still use the old one. */
  warmup: boolean;
  /** Time since that change at the moment of the send. */
  ruleChangedAgoMs?: number;
  /** What the provisioner did in `notification_setup`. */
  provisioning?: ProvisionResult;
  /** Threshold POSTs of the run that had arrived when the repeat was about to be sent. */
  thresholdBeforeRepeat?: Arrival[];
  /** Registrations of the tunnel connection counted when `notification_setup` ended. */
  registrationsAtSetup?: number;
}

/** Host of the address a process used for the last run. */
export interface LastHostname {
  /** Host with the port when it has one; absent before the first run. */
  value?: string;
}

/** Everything a notification stage needs. */
export interface NotificationContext extends ScenarioContext {
  /** Receiver of the notifications. */
  receiver: Receiver;
  /** Keeps the rule of the instance right. */
  provisioner: Provisioner;
  /** Settings of the notification part of the configuration. */
  settings: ReturnType<typeof notificationSettings>;
  /** Public address, known after `notification_setup` found it. */
  address?: PublicAddress;
  /** Finds the public address. */
  resolveAddress: (signal: AbortSignal) => Promise<PublicAddress>;
  /** Adds a value to the secrets that output must not show. */
  addSecret: (value: string) => void;
  /** Host of the address of the previous run, shared by the runs of a process; a new host is waited for before the rule is changed. */
  lastHostname?: LastHostname;
  /** Pause between self-checks while waiting for a new address, 2000 ms by default. */
  addressPollMs?: number;
  /** Reads the registration counter of the tunnel; absent when the address does not come from the tunnel. */
  tunnelRegistrations?: (signal: AbortSignal) => Promise<number | undefined>;
  /** Shared state of the notification part. */
  notification: NotificationState;
}

/** What `tunnelReconnect` found. */
export interface ReconnectVerdict {
  /** `tunnel_reconnected` when the counter grew. */
  error?: CheckError;
  /** Why the counter could not be compared. */
  warning?: string;
}

/** Warning when the counter of tunnel registrations could not be read. */
export const UNREADABLE_REGISTRATIONS = 'The tunnel registration counter could not be read, so a tunnel reconnect cannot be told from a Hawk failure in this run';

/**
 * Tells whether the tunnel reconnected since `notification_setup`, after a wait that ended with nothing.
 * @param context Context of the stage.
 * @param waitedMs How long the wait lasted.
 * @param signal Aborts the read.
 * @param channel Channel that did not arrive, when the stage waits for one.
 * @returns `error` when the counter grew, `warning` when it cannot be compared, nothing otherwise.
 */
export async function tunnelReconnect(context: NotificationContext, waitedMs: number, signal: AbortSignal, channel?: ArrivalKind): Promise<ReconnectVerdict> {
  if (context.address?.source !== 'tunnel' || context.tunnelRegistrations === undefined) {
    return {};
  }

  const before = context.notification.registrationsAtSetup;

  if (before === undefined) {
    return { warning: UNREADABLE_REGISTRATIONS };
  }

  const after = await context.tunnelRegistrations(signal);

  if (after === undefined) {
    return { warning: UNREADABLE_REGISTRATIONS };
  }

  if (after > before) {
    return { error: new CheckError('tunnel_reconnected', { waitedMs,
      detail: `registrations ${String(before)} → ${String(after)}`,
      ...channel === undefined ? {} : { channel } }) };
  }

  return {};
}

/** An event of a webhook body. */
interface WebhookEvent {
  /** Id of the event. */
  id?: unknown;
  /** Title of the event. */
  title?: unknown;
}

/** The project of a webhook payload. */
interface WebhookProject {
  /** Id of the project. */
  id?: unknown;
}

/** One entry of the events of a webhook payload. */
interface WebhookItem {
  /** The event itself. */
  event?: WebhookEvent;
}

/** The part of a webhook payload the monitor reads. */
interface WebhookPayload {
  /** Project data. */
  project?: WebhookProject;
  /** Events of the notification. */
  events?: WebhookItem[];
}

/** The parts of a webhook body the monitor reads. */
interface WebhookBody {
  /** Kind of the notification. */
  type?: unknown;
  /** Payload of the notification. */
  payload?: WebhookPayload;
}

/**
 * Prints a compared value for an error text.
 * @param value Anything.
 * @returns The string itself or its JSON.
 */
function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? 'missing';
}

/**
 * Builds a mismatch error.
 * @param field Name of the field.
 * @param expected What was expected.
 * @param actual What arrived.
 * @returns Error of class `notification_mismatch`.
 */
function mismatch(field: string, expected: string, actual: unknown): CheckError {
  return new CheckError('notification_mismatch', { field,
    expected,
    actual: show(actual) });
}

/**
 * Parses a webhook body.
 * @param rawBody Body text.
 * @returns The parsed object, or undefined when it is not a JSON object.
 */
function parseWebhook(rawBody: string): WebhookBody | undefined {
  try {
    const parsed = JSON.parse(rawBody) as unknown;

    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the id of the event a webhook is about.
 * @param rawBody Body text.
 * @returns The id, or undefined when the body has none.
 */
function webhookEventId(rawBody: string): string | undefined {
  const id = parseWebhook(rawBody)?.payload?.events?.[0]?.event?.id;

  return typeof id === 'string' ? id : undefined;
}

/**
 * Checks the headers, the type, the project and the title of a webhook.
 * @param arrival Webhook POST bound to the run.
 * @param title Title that was sent.
 * @param projectId Project of the monitor.
 * @returns The first difference, or undefined.
 */
export function checkWebhook(arrival: Arrival, title: string, projectId: string): CheckError | undefined {
  const headers = new Map(Object.entries(arrival.headers).map(([name, value]) => [name.toLowerCase(), value]));

  if (headers.get('user-agent') !== WEBHOOK_AGENT) {
    return mismatch('webhook.user-agent', WEBHOOK_AGENT, headers.get('user-agent'));
  }

  if (headers.get('x-hawk-notification') !== WEBHOOK_KIND) {
    return mismatch('webhook.x-hawk-notification', WEBHOOK_KIND, headers.get('x-hawk-notification'));
  }

  const body = parseWebhook(arrival.rawBody);

  if (body === undefined) {
    return mismatch('webhook.body', 'a JSON object', 'not JSON');
  }

  if (body.type !== WEBHOOK_KIND) {
    return mismatch('webhook.type', WEBHOOK_KIND, body.type);
  }

  const actualProject = body.payload?.project?.id;

  if (actualProject !== projectId) {
    return mismatch('webhook.project.id', projectId, actualProject);
  }

  const actualTitle = body.payload?.events?.[0]?.event?.title;

  return actualTitle === title ? undefined : mismatch('webhook.title', title, actualTitle);
}

/**
 * Checks that a loop message names the event by its title.
 * @param arrival Loop POST bound to the run.
 * @param title Title that was sent.
 * @returns The difference, or undefined.
 */
export function checkLoop(arrival: Arrival, title: string): CheckError | undefined {
  return arrival.rawBody.includes(title) ? undefined : mismatch('loop.title', title, 'a body without it');
}

/**
 * Checks the id of the event in the webhook and the link in the loop message.
 * @param arrivals What the receiver collected for the run.
 * @param event The event Hawk shows.
 * @param projectId Project of the monitor.
 * @returns The first difference, webhook before loop, or undefined.
 */
export function checkNotificationAgainstEvent(arrivals: Arrivals, event: FoundEvent, projectId: string): CheckError | undefined {
  const [webhook] = arrivals.webhook;
  const [loop] = arrivals.loop;

  if (webhook !== undefined) {
    const id = webhookEventId(webhook.rawBody);

    if (id !== event.originalEventId) {
      return mismatch('webhook.event.id', event.originalEventId, id);
    }
  }

  const link = `/project/${projectId}/event/${event.originalEventId}/`;

  return loop === undefined || loop.rawBody.includes(link) ? undefined : mismatch('loop.link', link, 'a body without it');
}

/**
 * Builds the hook that runs right before the event is sent.
 * The receiver must know the run before the notification can come, and the warmup is judged at the moment the notifier will read the rules.
 * @param context Context whose receiver and provisioner the hook uses.
 * @returns Hook for `collectorAcceptStage`.
 */
export function notificationBeforeSend(context: NotificationContext): () => void {
  return () => {
    const { notification, provisioner, receiver, plan, settings } = context;
    const remainingMs = provisioner.warmupRemainingMs();

    receiver.expect(plan.runId);
    notification.warmup = remainingMs > 0;
    if (notification.warmup) {
      notification.ruleChangedAgoMs = settings.ruleCacheWarmupMs - remainingMs;
    }
  };
}

/**
 * Waits until the receiver answers through an address, trying once per pause.
 * @param context Context of the stage.
 * @param address The address to check.
 * @param deadlineMs `clock.monotonicMs()` value after which no new try starts; undefined polls until the signal aborts.
 * @param signal Timeout of the stage.
 * @returns Resolves when a self-check passes.
 * @throws CheckError of the last self-check when the deadline or the timeout ends first.
 */
async function waitForAddress(context: NotificationContext, address: PublicAddress, deadlineMs: number | undefined, signal: AbortSignal): Promise<void> {
  const { config, clock, receiver, settings } = context;
  const pauseMs = context.addressPollMs ?? DEFAULT_ADDRESS_POLL_MS;
  let last: CheckError | undefined;

  for (;;) {
    const remaining = deadlineMs === undefined ? config.httpTimeoutMs : deadlineMs - clock.monotonicMs();

    // The monotonic clock is fractional and a request timeout must be a whole number of milliseconds.
    const probeTimeoutMs = Math.ceil(Math.min(config.httpTimeoutMs, Math.max(remaining, pauseMs)));

    try {
      await probeReceiver(address, settings.receiverSecret, receiver.nonce, { httpTimeoutMs: probeTimeoutMs,
        clock,
        attempts: 1,
        retry: config.retry }, signal);

      return;
    } catch (error) {
      if (!isCheckError(error)) {
        throw error;
      }

      last = error;
    }

    if (deadlineMs !== undefined && deadlineMs - clock.monotonicMs() < pauseMs) {
      throw last;
    }

    try {
      await clock.sleep(pauseMs, signal);
    } catch {
      throw last;
    }
  }
}

/**
 * Stage `notification_setup`: finds the public address, checks the receiver through it and brings the rule to the wanted state.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function notificationSetupStage(timeoutMs: number): StageSpec<NotificationContext> {
  return {
    name: 'notification_setup',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { config, clock, notification, provisioner, receiver, settings } = context;
      const startedMs = clock.monotonicMs();
      const address = await context.resolveAddress(signal);

      context.address = address;
      // Hawk texts carry the bare hostname without the port, so every form is masked.
      context.addSecret(address.baseUrl);
      context.addSecret(address.hostname);
      context.addSecret(new URL(address.baseUrl).hostname);

      const previous = context.lastHostname?.value;

      // Provisioning runs in the same stage, so the probe leaves it two request timeouts.
      const windowMs = timeoutMs - 2 * config.httpTimeoutMs;

      if (address.source === 'tunnel' && windowMs > 0) {
        await waitForAddress(context, address, startedMs + windowMs, signal);
      } else if (previous !== undefined && previous !== address.hostname) {
        await waitForAddress(context, address, undefined, signal);
      } else {
        await probeReceiver(address, settings.receiverSecret, receiver.nonce, { httpTimeoutMs: config.httpTimeoutMs,
          clock,
          attempts: config.retry.attempts,
          retry: config.retry }, signal);
      }

      if (context.lastHostname !== undefined) {
        context.lastHostname.value = address.hostname;
      }

      const details: StageDetails = {};

      // Read before provisioning, which may spend most of the time left to the stage.
      if (address.source === 'tunnel' && context.tunnelRegistrations !== undefined) {
        notification.registrationsAtSetup = await context.tunnelRegistrations(signal);

        if (notification.registrationsAtSetup === undefined) {
          details.warning = UNREADABLE_REGISTRATIONS;
        }
      }

      const result = await provisioner.provision(address, signal);

      notification.provisioning = result;
      details.provisioning = { action: result.action,
        deleted: result.deleted,
        matchChanged: result.matchChanged };

      return { status: 'ok',
        details };
    },
  };
}

/**
 * Names the channels that did not arrive.
 * @param arrivals What the receiver has.
 * @param channels Channels the run waits for.
 * @returns Those with no POST.
 */
function missingChannels(arrivals: Arrivals, channels: readonly NotificationChannel[]): NotificationChannel[] {
  return channels.filter(channel => arrivals[channel].length === 0);
}

/**
 * Stage `notification_formed`: waits for the webhook and loop POSTs of the run and checks them.
 * @param timeoutMs Time limit of the stage; room for one probe after the wait.
 * @returns Stage spec.
 */
export function notificationFormedStage(timeoutMs: number): StageSpec<NotificationContext> {
  return {
    name: 'notification_formed',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, config, notification, plan, receiver, settings, state } = context;

      if (notification.warmup) {
        const ago = Math.ceil((notification.ruleChangedAgoMs ?? 0) / MS_PER_SECOND);

        return { status: 'skipped',
          details: { reason: 'rule_cache_warmup',
            warmupRemainingMs: Math.max(0, settings.ruleCacheWarmupMs - (notification.ruleChangedAgoMs ?? 0)),
            warning: `Notification check skipped: the notification rule changed ${String(ago)} s ago, Hawk caches rules for 60 s` } };
      }

      const channels: NotificationChannel[] = settings.loop ? ['webhook', 'loop'] : ['webhook'];
      const startedMs = clock.monotonicMs();
      const arrivals = await receiver.wait(plan.runId, { channels,
        timeoutMs: settings.timeoutMs,
        pairWaitMs: settings.pairWaitMs,
        signal });
      const waitedMs = Math.round(clock.monotonicMs() - startedMs);
      const missing = missingChannels(arrivals, channels);
      const details: StageDetails = { unmatched: arrivals.unmatched };

      notification.arrivals = arrivals;

      if (missing.length === channels.length) {
        const { address } = context;

        details.waitedMs = waitedMs;

        const reconnect = await tunnelReconnect(context, waitedMs, signal);

        if (reconnect.error !== undefined) {
          return { status: 'failed',
            error: reconnect.error,
            details };
        }

        if (reconnect.warning !== undefined) {
          details.warning = reconnect.warning;
        }

        try {
          if (address === undefined) {
            throw new CheckError('monitor_internal', { detail: 'notification_formed ran without a public address' });
          }

          await probeReceiver(address, settings.receiverSecret, receiver.nonce, { httpTimeoutMs: config.httpTimeoutMs,
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
          error: new CheckError('notification_timeout', { detail: settings.loop ? 'both' : 'webhook_only',
            waitedMs }),
          details };
      }

      const [webhook] = arrivals.webhook;
      const [loop] = arrivals.loop;
      const problem = (webhook === undefined ? undefined : checkWebhook(webhook, plan.title, config.hawk.projectId))
        ?? (loop === undefined ? undefined : checkLoop(loop, plan.title));

      if (problem) {
        return { status: 'failed',
          error: problem,
          details };
      }

      const latencyMs: Partial<Record<ArrivalKind, number>> = {};

      for (const arrival of [webhook, loop]) {
        if (arrival !== undefined && state.acceptedAtMs !== undefined) {
          latencyMs[arrival.channel] = Math.round(arrival.atMs - state.acceptedAtMs);
        }
      }

      details.latencyMs = latencyMs;

      if (webhook !== undefined) {
        details.eventId = webhookEventId(webhook.rawBody);
      }

      if (arrivals.unmatched > 0) {
        details.warnings = [`${String(arrivals.unmatched)} notification(s) with a valid secret but another run id arrived while waiting`];
      }

      const [absent] = missing;

      if (absent !== undefined) {
        const [present] = channels.filter(channel => channel !== absent);
        const first = Math.min(...[webhook, loop].flatMap(arrival => arrival === undefined ? [] : [arrival.atMs]));

        details.warning = `Only the ${String(present)} notification arrived; the ${absent} sender did not deliver within ${formatDuration(clock.monotonicMs() - first)}`;
      }

      return { status: 'ok',
        details };
    },
  };
}

/**
 * Builds the hook that runs right before the event is sent again.
 * A threshold POST that is already there came before the repeat, which Hawk must not send for.
 * @param context Context whose receiver the hook reads.
 * @returns Hook for `eventRepeatedStage`.
 */
export function thresholdBeforeRepeat(context: NotificationContext): () => void {
  return () => {
    context.notification.thresholdBeforeRepeat = context.receiver.counts(context.plan.runId).threshold;
  };
}

/** An entry of the events of a webhook payload, as far as the repetition goes. */
interface RepetitionItem {
  /** Id of the repetition, null for a first event. */
  repetitionId?: unknown;
}

/**
 * Reads the id of the repetition a webhook body names.
 * @param rawBody Body text.
 * @returns The id, `null` for a first event, undefined when the body says nothing.
 */
function webhookRepetitionId(rawBody: string): string | null | undefined {
  const id = (parseWebhook(rawBody)?.payload?.events?.[0] as RepetitionItem | undefined)?.repetitionId;

  return typeof id === 'string' || id === null ? id : undefined;
}

/**
 * Stage `threshold_formed`: after the repeat, waits for the threshold notification and checks it.
 * A POST before the repeat, or one with no repetition id, is the rule firing on the first event.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function thresholdFormedStage(timeoutMs: number): StageSpec<NotificationContext> {
  return {
    name: 'threshold_formed',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, config, notification, plan, receiver, settings, state } = context;

      if (!plan.repeat) {
        return { status: 'skipped' };
      }

      if (notification.warmup) {
        return { status: 'skipped',
          details: { reason: 'rule_cache_warmup' } };
      }

      const early = notification.thresholdBeforeRepeat ?? [];

      if (early.length > 0) {
        return { status: 'failed',
          error: new CheckError('threshold_early', { detail: `${String(early.length)} POST before the event was repeated` }) };
      }

      const startedMs = clock.monotonicMs();
      const arrivals = await receiver.wait(plan.runId, { channels: ['threshold'],
        timeoutMs: settings.timeoutMs,
        pairWaitMs: settings.pairWaitMs,
        signal });
      const [arrival] = arrivals.threshold;

      if (arrival === undefined) {
        const waitedMs = Math.round(clock.monotonicMs() - startedMs);
        const details: StageDetails = { unmatched: arrivals.unmatched };
        const reconnect = await tunnelReconnect(context, waitedMs, signal, 'threshold');

        if (reconnect.error !== undefined) {
          return { status: 'failed',
            error: reconnect.error,
            details };
        }

        if (reconnect.warning !== undefined) {
          details.warning = reconnect.warning;
        }

        return { status: 'failed',
          error: new CheckError('notification_timeout', { channel: 'threshold',
            waitedMs }),
          details };
      }

      if (webhookRepetitionId(arrival.rawBody) === null) {
        return { status: 'failed',
          error: new CheckError('threshold_early', { detail: 'the POST names no repetition, so it was sent for the first event' }) };
      }

      const problem = checkWebhook(arrival, plan.title, config.hawk.projectId);

      if (problem) {
        return { status: 'failed',
          error: problem };
      }

      const sentAtMs = state.repeatAcceptedAtMs ?? state.acceptedAtMs;
      const details: StageDetails = { unmatched: arrivals.unmatched };

      if (sentAtMs !== undefined) {
        details.latencyMs = Math.round(arrival.atMs - sentAtMs);
      }

      return { status: 'ok',
        details };
    },
  };
}
