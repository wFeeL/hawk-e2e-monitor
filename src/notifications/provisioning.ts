import type { HawkApi } from '../clients/hawk-api.js';
import { CheckError, isCheckError } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import type { PublicAddress } from './address.js';
import type { ChannelSettings, NotificationChannels, NotificationRule, NotificationRuleInput } from './types.js';

const EXCLUDED_SCENARIO = 'send-and-receive-event';
const CHANNEL_NAMES = ['email', 'slack', 'loop', 'telegram', 'webhook'] as const;
const OFF: ChannelSettings = { isEnabled: false,
  endpoint: '' };
const ADMIN_TEXT = 'Not enough permissions: the monitor user must be an admin of the project workspace';
const NO_PERMISSIONS = 'Not enough permissions';
const UNRESOLVED_HOST = 'Cannot resolve webhook hostname';
const REFUSED = 'ECONNREFUSED';
const CREATED_AGAIN = 'rule created again';
const VALIDATOR_TEXT = /^(?:Invalid (email|slack|loop|telegram) endpoint passed|Invalid webhook URL|Webhook )/u;

/** What `provision` did. */
export interface ProvisionResult {
  /** Whether the rule was left, created or replaced. */
  action: 'none' | 'created' | 'updated';
  /** Extra rules of the instance that were deleted. */
  deleted: number;
  /** True when the notifier may still match events by the old rule for a while. */
  matchChanged: boolean;
  /** Id of the rule of the instance. */
  ruleId: string;
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
  /** How long the notifier may cache rules. */
  warmupMs: number;
}

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

/** A result with the first differing matching field. */
interface Decision extends ProvisionResult {
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
  const fields: [string, unknown][] = [['isEnabled', rule.isEnabled], ['whatToReceive', rule.whatToReceive], ['including', rule.including], ['excluding', rule.excluding]];

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
 * @returns JSON that equals for equal rules; ids, `minPeriod` and thresholds are left out.
 */
export function ruleProjection(rule: NotificationRule | NotificationRuleInput): string {
  return JSON.stringify(fieldsOf(rule, true));
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

/**
 * Builds the rule the instance should have.
 * @param deps Project, instance, secret and loop switch.
 * @param address Public address of the receiver.
 * @returns Input for create or update.
 */
export function desiredRule(deps: Pick<ProvisionerDeps, 'instanceId' | 'loop' | 'projectId' | 'secret'>, address: PublicAddress): NotificationRuleInput {
  return { projectId: deps.projectId,
    isEnabled: true,
    whatToReceive: 'ONLY_NEW',
    including: [`[e2e:${deps.instanceId}]`],
    excluding: [EXCLUDED_SCENARIO],
    channels: { email: OFF,
      slack: OFF,
      telegram: OFF,
      loop: { isEnabled: deps.loop,
        endpoint: `${address.baseUrl}/hooks/loop/${deps.secret}` },
      webhook: { isEnabled: true,
        endpoint: `${address.baseUrl}/hooks/webhook/${deps.secret}` } } };
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
 * Creates a provisioner that remembers when matching last changed.
 * @param deps Client, clock and the identity of the rule.
 * @returns Provisioner with its own warmup state.
 */
export function createProvisioner(deps: ProvisionerDeps): Provisioner {
  const { api, clock, projectId } = deps;
  let lastMatchChangeAtMs: number | undefined;
  let previousMatchChanged = false;

  // Set before the request goes out: an update that fails halfway may still have changed the rule.
  const markMatchChange = (): void => {
    lastMatchChangeAtMs = clock.monotonicMs();
  };

  const isOurs = (rule: NotificationRule): boolean => rule.including.length === 1 && rule.including[0] === `[e2e:${deps.instanceId}]`;
  const ownRules = async (signal: AbortSignal): Promise<NotificationRule[]> => (await api.notificationRules(projectId, signal)).filter(isOurs);

  /**
   * Reads the rules, decides what to change and changes it.
   * @param address Public address of the receiver.
   * @param signal Deadline of the caller.
   * @returns Result with the first differing field for the stability check.
   */
  const decide = async (address: PublicAddress, signal: AbortSignal): Promise<Decision> => {
    const wanted = desiredRule(deps, address);
    const mutate = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        throw classifyMutation(error, address, projectId);
      }
    };
    let rules = await ownRules(signal);
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

          outcome = { action: 'created',
            ruleId,
            matchChanged: true };
        } catch (error) {
          if (created || !outcomeUnknown(error)) {
            throw error;
          }

          created = true;
          forced = true;
          rules = await ownRules(signal);

          continue;
        }
      } else if (ruleProjection(first) === ruleProjection(wanted)) {
        outcome = { action: 'none',
          ruleId: first.id,
          matchChanged: false };
      } else {
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

          rules = await ownRules(signal);

          continue;
        }

        const difference = matchDifference(first, wanted);

        outcome = { action: 'updated',
          ruleId: updated,
          matchChanged: difference !== undefined,
          ...difference === undefined ? {} : { difference } };
      }

      for (const extra of extras) {
        await mutate(async () => api.deleteNotificationRule(projectId, extra.id, signal));
      }

      if (extras.length > 0 && (await ownRules(signal)).length > 1) {
        throw new CheckError('provisioning_conflict', { detail: 'an extra rule of the instance was not deleted' });
      }

      return { action: outcome.action,
        deleted: extras.length,
        matchChanged: outcome.matchChanged || forced,
        ruleId: outcome.ruleId,
        ...outcome.difference === undefined ? {} : { difference: outcome.difference } };
    }
  };

  return {
    async provision(address, signal) {
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
    },
    warmupRemainingMs() {
      return lastMatchChangeAtMs === undefined ? 0 : Math.max(0, deps.warmupMs - (clock.monotonicMs() - lastMatchChangeAtMs));
    },
  };
}
