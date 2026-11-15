import type { ChannelSettings, NotificationChannels, NotificationRule } from '../../../src/notifications/types.js';
import { objectIdLike } from './store.js';

const DEFAULT_MIN_PERIOD = 60;
const DEFAULT_THRESHOLD = 20;
const DEFAULT_THRESHOLD_PERIOD_MS = 3_600_000;
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/u;
const SLACK_PATTERN = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+$/u;
const TELEGRAM_PATTERN = /^https:\/\/notify\.bot\.codex\.so\/u\/[A-Za-z0-9]+$/u;
const LOOP_PATTERN = /^https:\/\/.+\/hooks\/.+$/u;
const LOOP_PATTERN_ALLOWING_HTTP = /^https?:\/\/.+\/hooks\/.+$/u;
const ALLOWED_PORTS: Readonly<Record<string, number>> = Object.fromEntries([['http:', 80], ['https:', 443]]);
const BLOCKED_HOSTNAMES = [/^localhost$/iu, /\.local$/iu, /\.internal$/iu, /\.lan$/iu, /\.localdomain$/iu];
// The list of api:utils/ipValidator.ts, so the fake refuses what Hawk refuses.
const PRIVATE_IP_PATTERNS = [
  /^0\./u, /^10\./u, /^127\./u, /^169\.254\./u, /^172\.(1[6-9]|2\d|3[01])\./u, /^192\.168\./u,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u, /^255\.255\.255\.255$/u, /^2(2[4-9]|3\d)\./u,
  /^192\.0\.2\./u, /^198\.51\.100\./u, /^203\.0\.113\./u, /^198\.1[89]\./u,
  /^::1$/u, /^::$/u, /^fe80/iu, /^f[cd]/iu, /^ff[0-9a-f]{2}:/iu,
  /^::ffff:(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/iu,
];
const MANDATORY_CHANNELS = ['email', 'slack', 'loop', 'telegram'] as const;

/** An error the fake API turns into a GraphQL error. */
export interface FakeRuleError {
  /** `extensions.code`. */
  code: 'BAD_USER_INPUT' | 'INTERNAL_SERVER_ERROR';
  /** Message as Hawk words it. */
  message: string;
}

/** Notification rules per project, with the validation of the Hawk API. */
export interface FakeRules {
  /**
   * Lists the rules of a project.
   * @param projectId Project that owns the rules.
   * @returns Copies, newest first as in Hawk.
   */
  list(projectId: string): NotificationRule[];
  /**
   * Validates and adds a rule at the start of the list.
   * @param projectId Project that owns the rules.
   * @param input `CreateProjectNotificationsRuleInput` as received.
   * @returns The new rule, or the error Hawk would answer with.
   */
  create(projectId: string, input: unknown): NotificationRule | FakeRuleError;
  /**
   * Validates and replaces a rule as a whole.
   * @param projectId Project that owns the rules.
   * @param input `UpdateProjectNotificationsRuleInput` as received.
   * @returns The new rule, null when the rule does not exist, or the error Hawk would answer with.
   */
  update(projectId: string, input: unknown): NotificationRule | null | FakeRuleError;
  /**
   * Removes a rule; Hawk answers `null` either way, so nothing is returned.
   * @param projectId Project that owns the rules.
   * @param ruleId Rule to drop; an unknown one is ignored.
   */
  remove(projectId: string, ruleId: string): void;
  /**
   * Puts a rule at the start of the list as it is, without validation.
   * @param projectId Project that owns the rules.
   * @param rule Rule to keep, copied.
   */
  seed(projectId: string, rule: NotificationRule): void;
  /**
   * Counts the changes made to the rules of a project.
   * @param projectId Project that owns the rules.
   * @returns Starts at 0 and grows by one on each create, update, remove and seed that changed something.
   */
  version(projectId: string): number;
}

/** What the validation asks the fake API about. */
export interface FakeRulesOptions {
  /** True lets webhooks point to private addresses and other ports, and loop use http. */
  allowPrivateWebhook: () => boolean;
  /** Tells whether DNS knows the host. */
  resolves: (host: string) => boolean;
}

/** A channel after the input defaults. */
type ChannelMap = Record<string, ChannelSettings | undefined>;

/**
 * Reads a plain object.
 * @param value Anything.
 * @returns The object, or undefined for other values.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Builds a GraphQL input error.
 * @param what What is wrong.
 * @returns Error with the code Apollo uses for bad variables.
 */
function badInput(what: string): FakeRuleError {
  return { code: 'BAD_USER_INPUT',
    message: `Variable "$input" got invalid value: ${what}` };
}

/**
 * Reads a list of strings, empty when absent.
 * @param value Input value.
 * @returns The list, or undefined when it is not a list of strings.
 */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : undefined;
}

/**
 * Applies the input defaults to one channel.
 * @param value Channel as sent; null and undefined mean "not sent".
 * @returns Settings, undefined when not sent, or an error text for a bad shape.
 */
function readChannel(value: unknown): ChannelSettings | string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const record = asRecord(value);

  if (record === undefined || typeof record.endpoint !== 'string') {
    return 'channel endpoint must be a string';
  }

  const isEnabled = record.isEnabled ?? true;
  const minPeriod = record.minPeriod ?? DEFAULT_MIN_PERIOD;

  if (typeof isEnabled !== 'boolean' || typeof minPeriod !== 'number') {
    return 'channel isEnabled must be a boolean and minPeriod a number';
  }

  return { isEnabled,
    endpoint: record.endpoint,
    minPeriod };
}

/**
 * Checks a webhook address the way `validateWebhookEndpoint` does.
 * @param endpoint Address.
 * @param options Switches of the fake.
 * @returns Hawk's text, or null when the address passes.
 */
function webhookError(endpoint: string, options: FakeRulesOptions): string | null {
  if (!URL.canParse(endpoint)) {
    return 'Invalid webhook URL';
  }

  const url = new URL(endpoint);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Webhook URL must use http or https protocol';
  }

  const allowPrivate = options.allowPrivateWebhook();
  const allowedPort = ALLOWED_PORTS[url.protocol];
  const requestedPort = url.port === '' ? allowedPort : Number(url.port);

  if (!allowPrivate && requestedPort !== allowedPort) {
    return `Webhook URL port ${String(requestedPort)} is not allowed — only 80 (http) and 443 (https)`;
  }

  const { hostname } = url;

  if (BLOCKED_HOSTNAMES.some(pattern => pattern.test(hostname))) {
    return `Webhook hostname "${hostname}" is not allowed`;
  }

  if (!allowPrivate && PRIVATE_IP_PATTERNS.some(pattern => pattern.test(hostname))) {
    return 'Webhook URL points to a private/reserved IP address';
  }

  return options.resolves(hostname) ? null : `Cannot resolve webhook hostname "${hostname}"`;
}

/**
 * Validates the channels in the order of `validateNotificationsRuleChannels`: each mandatory
 * channel is read without `?.`, so a missing one throws a TypeError at its turn.
 * @param channels Channels after the defaults.
 * @param options Switches of the fake.
 * @returns An error, or null when all enabled channels are valid.
 */
function validateChannels(channels: ChannelMap, options: FakeRulesOptions): FakeRuleError | null {
  const patterns: Record<(typeof MANDATORY_CHANNELS)[number], readonly [RegExp, string]> = {
    email: [EMAIL_PATTERN, 'Invalid email endpoint passed'],
    slack: [SLACK_PATTERN, 'Invalid slack endpoint passed'],
    loop: [options.allowPrivateWebhook() ? LOOP_PATTERN_ALLOWING_HTTP : LOOP_PATTERN, 'Invalid loop endpoint passed'],
    telegram: [TELEGRAM_PATTERN, 'Invalid telegram endpoint passed'],
  };

  for (const name of MANDATORY_CHANNELS) {
    const channel = channels[name];

    if (channel === undefined) {
      return { code: 'INTERNAL_SERVER_ERROR',
        message: `Cannot read properties of undefined (reading 'isEnabled')` };
    }

    const [pattern, message] = patterns[name];

    if (channel.isEnabled && !pattern.test(channel.endpoint)) {
      return { code: 'BAD_USER_INPUT',
        message };
    }
  }

  const { webhook } = channels;

  if (webhook?.isEnabled === true) {
    const message = webhookError(webhook.endpoint, options);

    if (message !== null) {
      return { code: 'BAD_USER_INPUT',
        message };
    }
  }

  return null;
}

/**
 * Builds the rule Hawk adds to every new project.
 * @param email Email of the project creator.
 * @param newId Id generator.
 * @returns `SEEN_MORE`, 20 events per hour, email on, no webhook.
 */
export function defaultRule(email: string, newId: () => string = objectIdLike): NotificationRule {
  const off: ChannelSettings = { isEnabled: false,
    endpoint: '',
    minPeriod: DEFAULT_MIN_PERIOD };

  return {
    id: newId(),
    isEnabled: true,
    whatToReceive: 'SEEN_MORE',
    including: [],
    excluding: [],
    threshold: DEFAULT_THRESHOLD,
    thresholdPeriod: DEFAULT_THRESHOLD_PERIOD_MS,
    channels: { email: { isEnabled: true,
      endpoint: email,
      minPeriod: DEFAULT_MIN_PERIOD },
    slack: { ...off },
    loop: { ...off },
    telegram: { ...off },
    webhook: null },
  };
}

/**
 * Creates the rule store of a fake API.
 * @param options Switches the validation reads on every call.
 * @param newId Id generator, ObjectId-like ids by default.
 * @returns Empty store.
 */
export function createFakeRules(options: FakeRulesOptions, newId: () => string = objectIdLike): FakeRules {
  const projects = new Map<string, NotificationRule[]>();
  const versions = new Map<string, number>();

  const rulesOf = (projectId: string): NotificationRule[] => {
    let rules = projects.get(projectId);

    if (!rules) {
      rules = [];
      projects.set(projectId, rules);
    }

    return rules;
  };
  const changed = (projectId: string): void => {
    versions.set(projectId, (versions.get(projectId) ?? 0) + 1);
  };

  /**
   * Builds a rule from the input, or says what is wrong with it.
   * @param id Id of the rule; the create path fills it in later.
   * @param input Input as received.
   * @returns The rule or the error of the first failing check.
   */
  const build = (id: string, input: Record<string, unknown>): NotificationRule | FakeRuleError => {
    const rawChannels = asRecord(input.channels);

    if (rawChannels === undefined) {
      return badInput('channels must be an object');
    }

    const channels: ChannelMap = {};

    for (const name of ['email', 'slack', 'loop', 'telegram', 'webhook']) {
      const channel = readChannel(rawChannels[name]);

      if (typeof channel === 'string') {
        return badInput(channel);
      }

      channels[name] = channel;
    }

    const including = stringList(input.including);
    const excluding = stringList(input.excluding);
    const whatToReceive = input.whatToReceive ?? 'ONLY_NEW';
    const isEnabled = input.isEnabled ?? true;

    if (including === undefined || excluding === undefined || typeof isEnabled !== 'boolean') {
      return badInput('including and excluding must be lists of strings, isEnabled a boolean');
    }

    if (whatToReceive !== 'ONLY_NEW' && whatToReceive !== 'SEEN_MORE') {
      return badInput('whatToReceive must be ONLY_NEW or SEEN_MORE');
    }

    const error = validateChannels(channels, options);

    if (error) {
      return error;
    }

    const rule: NotificationRule = {
      id,
      isEnabled,
      whatToReceive,
      including,
      excluding,
      channels: { email: channels.email,
        slack: channels.slack,
        loop: channels.loop,
        telegram: channels.telegram,
        webhook: channels.webhook ?? null } as NotificationChannels,
    };

    if (whatToReceive === 'SEEN_MORE') {
      rule.threshold = typeof input.threshold === 'number' ? input.threshold : null;
      rule.thresholdPeriod = typeof input.thresholdPeriod === 'number' ? input.thresholdPeriod : null;
    }

    return rule;
  };

  const create: FakeRules['create'] = (projectId, input) => {
    const record = asRecord(input);

    if (record === undefined) {
      return badInput('input must be an object');
    }

    const built = build('', record);

    if ('code' in built) {
      return built;
    }

    // The id is taken after the checks, so a refused rule does not use one up.
    built.id = newId();
    rulesOf(projectId).unshift(built);
    changed(projectId);

    return structuredClone(built);
  };

  const update: FakeRules['update'] = (projectId, input) => {
    const record = asRecord(input);

    if (record === undefined || typeof record.ruleId !== 'string') {
      return badInput('input must be an object with a ruleId');
    }

    const built = build(record.ruleId, record);

    if ('code' in built) {
      return built;
    }

    const rules = rulesOf(projectId);
    const index = rules.findIndex(rule => rule.id === built.id);

    if (index === -1) {
      return null;
    }

    rules[index] = built;
    changed(projectId);

    return structuredClone(built);
  };

  const remove: FakeRules['remove'] = (projectId, ruleId) => {
    const rules = rulesOf(projectId);
    const index = rules.findIndex(rule => rule.id === ruleId);

    if (index !== -1) {
      rules.splice(index, 1);
      changed(projectId);
    }
  };

  const seed: FakeRules['seed'] = (projectId, rule) => {
    rulesOf(projectId).unshift(structuredClone(rule));
    changed(projectId);
  };

  return {
    list: projectId => structuredClone(rulesOf(projectId)),
    create,
    update,
    remove,
    seed,
    version: projectId => versions.get(projectId) ?? 0,
  };
}
