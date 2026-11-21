import type { HawkApi } from '../clients/hawk-api.js';
import { CheckError, isCheckError } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import type { PublicAddress } from './address.js';
import type { ChannelSettings, NotificationChannels, NotificationRule, NotificationRuleInput } from './types.js';
import { CHECK_NOTIFICATION, EVENT_SCENARIOS, TELEGRAM_DELIVERY } from '../scenarios/names.js';

const CHANNEL_NAMES = ['email', 'slack', 'loop', 'telegram', 'webhook'] as const;
const OFF: ChannelSettings = { isEnabled: false,
  endpoint: '' };
const ADMIN_TEXT = 'Not enough permissions: the monitor user must be an admin of the project workspace';
const NO_PERMISSIONS = 'Not enough permissions';
const UNRESOLVED_HOST = 'Cannot resolve webhook hostname';
const REFUSED = 'ECONNREFUSED';
const CREATED_AGAIN = 'rule created again';
const THRESHOLD = 2;
const THRESHOLD_PERIOD_MS = 3_600_000;
const VALIDATOR_TEXT = /^(?:Invalid (email|slack|loop|telegram) endpoint passed|Invalid webhook URL|Webhook )/u;

/** What `provision` did. */
export interface ProvisionResult {
  /** Whether the rules were left, one was created or one was replaced; creating wins over replacing. */
  action: 'none' | 'created' | 'updated';
  /** Extra rules of the instance that were deleted. */
  deleted: number;
  /** True when the notifier may still match events by the old rule for a while. */
  matchChanged: boolean;
  /** Id of the rule of the instance that tells about new events; absent when the provisioner does not keep it. */
  ruleId?: string;
  /** Id of the rule of the instance that tells when an event repeats; absent when the provisioner does not keep it. */
  thresholdRuleId?: string;
  /** Id of the rule of the instance that sends to Telegram; absent when the provisioner does not keep it. */
  telegramRuleId?: string;
}

/** Keeps the rule of the instance in the wanted state. */
export interface Provisioner {
  /**
   * Brings the rule of the instance to the wanted state.
   * @param address Public address of the receiver.
   * @param signal Deadline of the caller.
   * @returns What was done.
   * @throws CheckError of a provisioning class, or the class of the failed API call.
   */
  provision(address: PublicAddress, signal: AbortSignal): Promise<ProvisionResult>;
  /**
   * Tells how long the notifier may still hold the old rule.
   * @returns Milliseconds left, 0 when no wait is needed.
   */
  warmupRemainingMs(): number;
}

/** Dependencies of a provisioner. */
export interface ProvisionerDeps {
  /** Hawk API client. */
  api: HawkApi;
  /** Clock of the warmup. */
  clock: Clock;
  /** Project that owns the rule. */
  projectId: string;
  /** Instance id; the rule is found by it. */
  instanceId: string;
  /** Secret in the channel paths. */
  secret: string;
  /** Whether the loop channel is on. */
  loop: boolean;
  /** Which rules this provisioner keeps; the new-events and threshold rules of check-notification when absent. */
  kinds?: readonly RuleKind[];
  /** Address of the Telegram channel of the Telegram rule; required when `kinds` has `telegram`. */
  notifyUrl?: string;
  /** How long the notifier may cache rules. */
  warmupMs: number;
  /** Wall-clock time of the last change that affected matching, as an earlier process stored it. */
  lastMatchChangeAtWallMs?: number;
  /** Called with the wall-clock time of every such change, so it can be stored; a failure is ignored. */
  onMatchChange?: (wallMs: number) => void;
}

/** Which of the rules of the instance is meant. */
export type RuleKind = 'newEvents' | 'threshold' | 'telegram';

const NOTIFICATION_KINDS: readonly RuleKind[] = ['newEvents', 'threshold'];

/** Decision about the rule found in Hawk. */
interface Outcome {
  /** What was done. */
  action: ProvisionResult['action'];
  /** Id of the rule. */
  ruleId: string;
  /** Whether matching changed. */
  matchChanged: boolean;
  /** First matching field that differs. */
  difference?: string;
}

/** What was done about the rules of all kinds. */
interface Decided extends ProvisionResult {
  /** First field that made matching change. */
  difference?: string;
}

/** What was done about the rules of one kind. */
interface Decision {
  /** Whether the rule was left, created or replaced. */
  action: ProvisionResult['action'];
  /** Extra rules of that kind that were deleted. */
  deleted: number;
  /** Whether matching changed. */
  matchChanged: boolean;
  /** Id of the rule. */
  ruleId: string;
  /** Field that made matching change. */
  difference?: string;
}

/**
 * Reads the channel of a rule as it is compared.
 * @param channels Channels of a rule or an input.
 * @param name One of the five channel names.
 * @returns The channel, a disabled one when it is null.
 */
function channelOf(channels: NotificationChannels | NotificationRuleInput['channels'], name: typeof CHANNEL_NAMES[number]): ChannelSettings {
  return channels[name] ?? OFF;
}

/**
 * Lists the compared fields of a rule.
 * @param rule Stored rule or input.
 * @param withEndpoints Whether channel addresses are part of the list.
 * @returns Field name and value pairs in a fixed order.
 */
function fieldsOf(rule: NotificationRule | NotificationRuleInput, withEndpoints: boolean): [string, unknown][] {
  // Hawk answers null for a rule that has no threshold, the wanted rule leaves it out.
  const fields: [string, unknown][] = [['isEnabled', rule.isEnabled], ['whatToReceive', rule.whatToReceive], ['including', rule.including], ['excluding', rule.excluding],
    ['threshold', rule.threshold ?? null], ['thresholdPeriod', rule.thresholdPeriod ?? null]];

  for (const name of CHANNEL_NAMES) {
    const channel = channelOf(rule.channels, name);

    fields.push([`channels.${name}.isEnabled`, channel.isEnabled]);

    if (withEndpoints) {
      fields.push([`channels.${name}.endpoint`, channel.endpoint]);
    }
  }

  return fields;
}

/**
 * Serializes the fields the monitor writes.
 * @param rule Stored rule or input.
 * @returns JSON that equals for equal rules; ids and `minPeriod` are left out, the threshold and its period count.
 */
export function ruleProjection(rule: NotificationRule | NotificationRuleInput): string {
  return JSON.stringify(fieldsOf(rule, true));
}

/**
 * Serializes the addresses a rule delivers to.
 * @param rule Stored rule or input.
 * @returns JSON of the channel addresses in a fixed order.
 */
function endpointsOf(rule: NotificationRule | NotificationRuleInput): string {
  return JSON.stringify(CHANNEL_NAMES.map(name => channelOf(rule.channels, name).endpoint));
}

/**
 * Finds the first matching field in which two rules differ.
 * @param stored Rule in Hawk.
 * @param wanted Wanted rule.
 * @returns Field name, undefined when only addresses differ or nothing does.
 */
function matchDifference(stored: NotificationRule, wanted: NotificationRuleInput): string | undefined {
  const right = fieldsOf(wanted, false);

  return fieldsOf(stored, false).find(([, value], index) => JSON.stringify(value) !== JSON.stringify(right[index]?.[1]))?.[0];
}

/** The rules for new events and for repeats; the Telegram rule is built apart. */
export interface DesiredRules {
  /** Tells about new events on the webhook and loop channels. */
  newEvents: NotificationRuleInput;
  /** Tells when an event repeats, on its own webhook path. */
  threshold: NotificationRuleInput;
}

/**
 * Builds the rule that tells about new events.
 * @param deps Project, instance, secret and loop switch.
 * @param address Public address of the receiver.
 * @returns Input for create or update.
 */
export function desiredRule(deps: Pick<ProvisionerDeps, 'instanceId' | 'loop' | 'projectId' | 'secret'>, address: PublicAddress): NotificationRuleInput {
  return { projectId: deps.projectId,
    isEnabled: true,
    whatToReceive: 'ONLY_NEW',
    including: [`[e2e:${deps.instanceId}]`],
    excluding: EVENT_SCENARIOS.filter(name => name !== CHECK_NOTIFICATION),
    channels: { email: OFF,
      slack: OFF,
      telegram: OFF,
      loop: { isEnabled: deps.loop,
        endpoint: `${address.baseUrl}/hooks/loop/${deps.secret}` },
      webhook: { isEnabled: true,
        endpoint: `${address.baseUrl}/hooks/webhook/${deps.secret}` } } };
}

/**
 * Builds the new-events and threshold rules the instance should have.
 * @param deps Project, instance, secret and loop switch.
 * @param address Public address of the receiver.
 * @returns The new-events rule and the threshold rule: two events of one group in an hour.
 */
export function desiredRules(deps: Pick<ProvisionerDeps, 'instanceId' | 'loop' | 'projectId' | 'secret'>, address: PublicAddress): DesiredRules {
  const newEvents = desiredRule(deps, address);

  return { newEvents,
    threshold: { ...newEvents,
      whatToReceive: 'SEEN_MORE',
      threshold: THRESHOLD,
      thresholdPeriod: THRESHOLD_PERIOD_MS,
      channels: { ...newEvents.channels,
        loop: OFF,
        webhook: { isEnabled: true,
          endpoint: `${address.baseUrl}/hooks/threshold/${deps.secret}` } } } };
}

/**
 * Builds the rule that sends the event to Telegram and tells the receiver about it.
 * @param deps Project, instance, secret and the notify address.
 * @param address Public address of the receiver.
 * @returns Input for create or update: Telegram and the webhook of `/hooks/telegram/` on, the rest off.
 * @throws CheckError `monitor_internal` when the notify address is missing.
 */
export function desiredTelegramRule(deps: Pick<ProvisionerDeps, 'instanceId' | 'notifyUrl' | 'projectId' | 'secret'>, address: PublicAddress): NotificationRuleInput {
  if (deps.notifyUrl === undefined) {
    throw new CheckError('monitor_internal', { detail: 'the Telegram rule needs TELEGRAM_NOTIFY_URL' });
  }

  return { projectId: deps.projectId,
    isEnabled: true,
    whatToReceive: 'ONLY_NEW',
    including: [`[e2e:${deps.instanceId}]`],
    excluding: EVENT_SCENARIOS.filter(name => name !== TELEGRAM_DELIVERY),
    channels: { email: OFF,
      slack: OFF,
      loop: OFF,
      telegram: { isEnabled: true,
        endpoint: deps.notifyUrl },
      webhook: { isEnabled: true,
        endpoint: `${address.baseUrl}/hooks/telegram/${deps.secret}` } } };
}

/**
 * Tells whether a failed create may have reached Hawk.
 * @param error Thrown value.
 * @returns True when the request was possibly sent.
 */
function outcomeUnknown(error: unknown): boolean {
  return isCheckError(error) && error.errorClass === 'api_unavailable' && error.facts.code !== REFUSED;
}

/**
 * Turns an error of a rule mutation into the class the monitor reports.
 * @param error Thrown value.
 * @param address Address that was written.
 * @param projectId Project of the rule.
 * @returns The error to throw.
 */
function classifyMutation(error: unknown, address: PublicAddress, projectId: string): unknown {
  if (!isCheckError(error)) {
    return error;
  }

  const text = error.facts.detail ?? '';

  if (error.errorClass === 'api_query_rejected' && text.includes(UNRESOLVED_HOST)) {
    return address.source === 'tunnel'
      ? new CheckError('tunnel_unavailable', { detail: `Hawk cannot resolve the tunnel hostname: ${text}` }, { cause: error })
      : new CheckError('notification_endpoint_rejected', { channel: 'webhook',
        detail: text }, { cause: error });
  }

  const validator = error.errorClass === 'api_query_rejected' ? VALIDATOR_TEXT.exec(text) : null;

  if (validator) {
    return new CheckError('notification_endpoint_rejected', { channel: validator[1] ?? 'webhook',
      detail: text }, { cause: error });
  }

  if (error.errorClass === 'api_forbidden' && text.includes(NO_PERMISSIONS)) {
    return new CheckError('api_forbidden', { ...error.facts,
      projectId,
      detail: ADMIN_TEXT }, { cause: error });
  }

  return error;
}

/**
 * Turns the stored wall-clock time of the last change into a point on the monotonic clock.
 * The age is capped to the warmup, so a clock that jumped back never extends the wait.
 * @param deps Dependencies with the stored time and the warmup.
 * @param clock Clock of the provisioner.
 * @returns Monotonic time of the change, or undefined when none is stored.
 */
function restoredChange(deps: ProvisionerDeps, clock: Clock): number | undefined {
  if (deps.lastMatchChangeAtWallMs === undefined) {
    return undefined;
  }

  const ageMs = Math.min(Math.max(0, clock.wallTime().getTime() - deps.lastMatchChangeAtWallMs), deps.warmupMs);

  return clock.monotonicMs() - ageMs;
}

/**
 * Creates a provisioner that remembers when matching last changed.
 * @param deps Client, clock and the identity of the rule.
 * @returns Provisioner with its own warmup state.
 */
export function createProvisioner(deps: ProvisionerDeps): Provisioner {
  const { api, clock, projectId } = deps;
  let lastMatchChangeAtMs = restoredChange(deps, clock);
  let previousMatchChanged = false;
  // Addresses this process wrote last, per kind: a rule that differs in addresses only after we wrote ours was rewritten by someone else.
  const written = new Map<RuleKind, string>();

  // Set before the request goes out: an update that fails halfway may still have changed the rule.
  const markMatchChange = (): void => {
    lastMatchChangeAtMs = clock.monotonicMs();

    try {
      deps.onMatchChange?.(clock.wallTime().getTime());
    } catch {
      // The caller logs its own storage failures; provisioning must not depend on them.
    }
  };

  const isOurs = (rule: NotificationRule): boolean => rule.including.length === 1 && rule.including[0] === `[e2e:${deps.instanceId}]`;
  const ownRules = async (kind: RuleKind, signal: AbortSignal): Promise<NotificationRule[]> => {
    const kindOf = kind === 'threshold' ? 'SEEN_MORE' : 'ONLY_NEW';
    const telegram = kind === 'telegram';

    // The Telegram flag tells rule T from the new-events rule, which has the same `whatToReceive`.
    return (await api.notificationRules(projectId, signal)).filter(rule => isOurs(rule) && rule.whatToReceive === kindOf && rule.channels.telegram.isEnabled === telegram);
  };

  /**
   * Reads the rules of one kind, decides what to change and changes it.
   * @param kind Which of the three rules is meant.
   * @param wanted The rule the instance should have.
   * @param address Public address of the receiver.
   * @param signal Deadline of the caller.
   * @returns Decision with the first differing field for the stability check.
   */
  const decideKind = async (kind: RuleKind, wanted: NotificationRuleInput, address: PublicAddress, signal: AbortSignal): Promise<Decision> => {
    const mutate = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        throw classifyMutation(error, address, projectId);
      }
    };
    let rules = await ownRules(kind, signal);
    let created = false;
    let nulls = 0;
    let forced = false;

    for (;;) {
      const [first, ...extras] = rules;
      let outcome: Outcome;

      if (first === undefined) {
        markMatchChange();

        try {
          const ruleId = await mutate(async () => api.createNotificationRule(wanted, signal));

          written.set(kind, endpointsOf(wanted));
          outcome = { action: 'created',
            ruleId,
            matchChanged: true };
        } catch (error) {
          if (created || !outcomeUnknown(error)) {
            throw error;
          }

          created = true;
          forced = true;
          rules = await ownRules(kind, signal);

          continue;
        }
      } else if (ruleProjection(first) === ruleProjection(wanted)) {
        outcome = { action: 'none',
          ruleId: first.id,
          matchChanged: false };
      } else {
        if (endpointsOf(first) !== endpointsOf(wanted) && written.get(kind) === endpointsOf(wanted)) {
          // Forget every kind: the other rule is stale too, and the next run takes both back; a monitor that is still alive is found again.
          written.clear();
          throw new CheckError('provisioning_conflict', { detail: `another monitor with INSTANCE_ID ${deps.instanceId} rewrites the rules; give each monitor its own INSTANCE_ID` });
        }

        if (matchDifference(first, wanted) !== undefined) {
          markMatchChange();
        }

        const updated = await mutate(async () => api.updateNotificationRule({ ...wanted,
          ruleId: first.id }, signal));

        if (updated === null) {
          nulls += 1;

          if (nulls > 1) {
            throw new CheckError('provisioning_conflict', { detail: 'the rule disappeared while it was being updated, twice' });
          }

          rules = await ownRules(kind, signal);

          continue;
        }

        written.set(kind, endpointsOf(wanted));

        const difference = matchDifference(first, wanted);

        outcome = { action: 'updated',
          ruleId: updated,
          matchChanged: difference !== undefined,
          ...difference === undefined ? {} : { difference } };
      }

      for (const extra of extras) {
        await mutate(async () => api.deleteNotificationRule(projectId, extra.id, signal));
      }

      if (extras.length > 0 && (await ownRules(kind, signal)).length > 1) {
        throw new CheckError('provisioning_conflict', { detail: 'an extra rule of the instance was not deleted' });
      }

      return { action: outcome.action,
        deleted: extras.length,
        matchChanged: outcome.matchChanged || forced,
        ruleId: outcome.ruleId,
        ...outcome.difference === undefined ? {} : { difference: outcome.difference } };
    }
  };

  const kinds = deps.kinds ?? NOTIFICATION_KINDS;

  /**
   * Brings the rules of the kinds to the wanted state and merges what was done.
   * @param address Public address of the receiver.
   * @param signal Deadline of the caller.
   * @returns Result with the first differing field for the stability check.
   */
  const decide = async (address: PublicAddress, signal: AbortSignal): Promise<Decided> => {
    const decisions = new Map<RuleKind, Decision>();

    for (const kind of kinds) {
      const wanted = kind === 'telegram'
        ? desiredTelegramRule(deps, address)
        : desiredRules(deps, address)[kind];

      decisions.set(kind, await decideKind(kind, wanted, address, signal));
    }

    const all = [...decisions.values()];
    const actions = all.map(decision => decision.action);
    const difference = all.find(decision => decision.difference !== undefined)?.difference;
    const idOf = (kind: RuleKind): string | undefined => decisions.get(kind)?.ruleId;

    return { action: actions.includes('created') ? 'created' : actions.includes('updated') ? 'updated' : 'none',
      deleted: all.reduce((sum, decision) => sum + decision.deleted, 0),
      matchChanged: all.some(decision => decision.matchChanged),
      ...idOf('newEvents') === undefined ? {} : { ruleId: idOf('newEvents') },
      ...idOf('threshold') === undefined ? {} : { thresholdRuleId: idOf('threshold') },
      ...idOf('telegram') === undefined ? {} : { telegramRuleId: idOf('telegram') },
      ...difference === undefined ? {} : { difference } };
  };

  const provision: Provisioner['provision'] = async (address, signal) => {
    const { difference, ...result } = await decide(address, signal);

    if (result.matchChanged) {
      markMatchChange();
    }

    const repeated = result.matchChanged && previousMatchChanged;

    previousMatchChanged = result.matchChanged;

    if (repeated) {
      throw new CheckError('provisioning_unstable', { detail: difference ?? CREATED_AGAIN });
    }

    return result;
  };

  const warmupRemainingMs: Provisioner['warmupRemainingMs'] = () => {
    return lastMatchChangeAtMs === undefined ? 0 : Math.max(0, deps.warmupMs - (clock.monotonicMs() - lastMatchChangeAtMs));
  };

  return {
    provision,
    warmupRemainingMs,
  };
}
