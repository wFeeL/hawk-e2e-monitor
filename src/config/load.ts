import type { z } from 'zod';
import { ENV_SHAPE, envSchema, fieldsSchema } from './schema.js';
import type { LogLevel, ParsedEnv, TransportMode } from './schema.js';
import type { Command } from '../cli.js';
import type { RetryPolicy } from '../net/retry.js';
import { CHECK_NOTIFICATION, TELEGRAM_DELIVERY } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';

/** Address of the internal HTTP server (health, readiness). */
export interface InternalConfig {
  /** Interface to listen on. */
  host: string;
  /** TCP port; 0 lets the OS choose. */
  port: number;
}

/** Access to the Hawk instance under test. */
export interface HawkConfig {
  /** GraphQL API URL. */
  apiUrl: string;
  /** Collector URL; undefined means derive it from the integration token. */
  collectorUrl: string | undefined;
  /** Integration token used to send test events. */
  integrationToken: string;
  /** Origin of Garage, the front end of Hawk; absent turns its check off. */
  garageUrl?: string;
  /** Id of the monitored project. */
  projectId: string;
  /** Login of the account that reads the project. */
  email: string;
  /** Password of that account. */
  password: string;
}

/** Time limits of the stages and of the whole run. */
export interface StageTimeouts {
  /** Stage `collector_availability`. */
  collectorAvailability: number;
  /** Stage `api_availability`. */
  apiAvailability: number;
  /** Stage `collector_accept`. */
  collectorAccept: number;
  /** Stage `event_visible`. */
  eventVisible: number;
  /** Stage `event_repeated`. */
  eventRepeated: number;
  /** Stage `cleanup`; counted outside `run`. */
  cleanup: number;
  /** Stage `garage_availability` of the probe. */
  garage: number;
  /** Stages 1-5 together. */
  run: number;
}

/** Settings of the notification receiver and the public address. */
export interface NotificationConfig {
  /** Interface the receiver listens on. */
  receiverHost: string;
  /** Receiver TCP port; 0 lets the OS choose. */
  receiverPort: number;
  /** Secret part of the receiver paths; required by the notification commands. */
  receiverSecret?: string;
  /** Fixed public https address of the receiver. */
  publicBaseUrl?: string;
  /** Metrics address of the tunnel that reports the public hostname. */
  tunnelMetricsUrl?: string;
  /** Whether the rule also has the loop channel. */
  loop: boolean;
  /** Time to wait for the notification. */
  timeoutMs: number;
  /** Time to wait for the second channel after the first. */
  pairWaitMs: number;
  /** Time limit of the stage that resolves the address and provisions the rule. */
  setupTimeoutMs: number;
  /** Time Hawk needs to reload the rules after a change that affects matching. */
  ruleCacheWarmupMs: number;
}

/** Ping that tells an outside service the monitor is alive. */
export interface HeartbeatConfig {
  /** Address to ping; absent turns the heartbeat off. */
  url?: string;
  /** Time between pings. */
  intervalMs: number;
}

/** Settings of the probe scenario. */
export interface ProbeConfig {
  /** Time between the starts of two probes. */
  intervalMs: number;
  /** Failed probes in a row that raise an alert. */
  alertAfterFailures: number;
  /** Days to keep finished probes. */
  retentionDays: number;
}

/** Settings of runs started by hand. */
export interface ManualRunConfig {
  /** Bearer token of `POST /runs/<scenario>`; absent turns the route off. */
  token?: string;
  /** Least time between two manual runs of one scenario. */
  minIntervalMs: number;
}

/** Settings of the continuous monitoring: schedule, history, alerts and cleanup. */
export interface MonitoringConfig {
  /** Scenarios to run, in the order the variable lists them. */
  scenarios: ScenarioName[];
  /** Time from the start of a run to the start of the next one of the same scenario. */
  intervalMs: number;
  /** Time added to the run and cleanup timeouts before a run counts as hung. */
  watchdogGraceMs: number;
  /** Delay between the first runs of consecutive scenarios. */
  staggerMs: number;
  /** Longest wait for the tunnel before the first notification run. */
  tunnelReadyTimeoutMs: number;
  /** Path of the SQLite file. */
  databasePath: string;
  /** Days to keep finished runs. */
  retentionDays: number;
  /** codex.bot notify URL; absent means alerts only go to the log. */
  alertNotifyUrl?: string;
  /** Failed runs in a row that raise an alert. */
  alertAfterFailures: number;
  /** Pause before an undelivered alert is sent again. */
  alertRetryMs: number;
  /** Time between sweeps of leftover events; 0 turns the sweep off. */
  sweepIntervalMs: number;
  /** Age a run must have before the sweep removes its event. */
  sweepMinAgeMs: number;
  /** Ping of an external service that tells the monitor is alive. */
  heartbeat: HeartbeatConfig;
  /** Runs started by hand over the internal port. */
  manual: ManualRunConfig;
  /** The `endpoints-probe` scenario. */
  probe: ProbeConfig;
}

/** Settings of the `telegram-delivery` scenario. */
export interface TelegramDeliveryConfig {
  /** Time between the starts of two runs. */
  intervalMs: number;
  /** Token of the bot that reads the group; checked when the scenario starts. */
  botToken?: string;
  /** Notify URL of @codex_bot that the Hawk rule delivers to; checked when the scenario starts. */
  notifyUrl?: string;
  /** Id of the group, as text; absent means any chat. */
  chatId?: string;
  /** Username of the bot that posts for Hawk. */
  senderUsername: string;
  /** Address of the Telegram Bot API. */
  apiUrl: string;
  /** Time to wait for the Telegram message of a run. */
  deliveryTimeoutMs: number;
  /** Time to wait for the probe message. */
  probeTimeoutMs: number;
}

/** Settings of the scenarios that have their own interval or time limit. */
export interface ScenariosConfig {
  /** Scenario `new-project`. */
  newProject: {
    /** Time between the starts of two runs. */
    intervalMs: number;
    /** Time the new token may take to be accepted. */
    tokenTimeoutMs: number;
  };
  /** Scenario `sourcemaps`. */
  sourcemaps: {
    /** Time between the starts of two runs. */
    intervalMs: number;
    /** Time Hawk may take to save the uploaded release. */
    releaseSaveTimeoutMs: number;
  };
  /** Scenario `sentry-envelope`. */
  sentryEnvelope: {
    /** Time between the starts of two runs. */
    intervalMs: number;
  };
  /** Scenario `telegram-delivery`. */
  telegramDelivery: TelegramDeliveryConfig;
}

/** Service configuration in the shape the rest of the code uses. */
export interface Config {
  /** Id of this monitor instance. */
  instanceId: string;
  /** Minimum level written to the log. */
  logLevel: LogLevel;
  /** Internal HTTP server address. */
  internal: InternalConfig;
  /** Time to let connections finish on shutdown. */
  shutdownTimeoutMs: number;
  /** Time limit for one health or readiness check. */
  healthCheckTimeoutMs: number;
  /** Access to Hawk. */
  hawk: HawkConfig;
  /** How a run picks its transport. */
  transportMode: TransportMode;
  /** Every N-th run of a transport repeats the event; 0 turns repeats off. */
  repeatEveryNRuns: number;
  /** Time limit of one HTTP request or WebSocket exchange. */
  httpTimeoutMs: number;
  /** Attempts and pauses for requests that fail on the network or with a 5xx answer. */
  retry: RetryPolicy;
  /** Pause before cleanup rechecks the event count; 0 turns it off. */
  lateDuplicateWaitMs: number;
  /** Time limits of the stages and the run. */
  timeouts: StageTimeouts;
  /** Notification receiver and public address. */
  notifications: NotificationConfig;
  /** Schedule, history, alerts and cleanup. */
  monitoring: MonitoringConfig;
  /** Own interval and time limits of the newer scenarios. */
  scenarios: ScenariosConfig;
}

/** Validated configuration together with the parsed environment. */
export interface LoadedConfig {
  /** Configuration for the service. */
  config: Config;
  /** Parsed variables, used for the secret-free summary. */
  env: ParsedEnv;
}

/** Successful `loadConfig` result. */
export interface LoadConfigOk extends LoadedConfig {
  /** Discriminant. */
  ok: true;
}

/** Failed `loadConfig` result. */
export interface LoadConfigFailure {
  /** Discriminant. */
  ok: false;
  /** Every invalid or missing variable. */
  errors: ConfigError[];
}

/** One invalid or missing environment variable. */
export interface ConfigError {
  /** Variable name. */
  variable: string;
  /** What is wrong; never contains the variable value. */
  message: string;
}

/** Thrown when a command needs settings the environment does not provide. */
export class ConfigFailure extends Error {
  public readonly errors: ConfigError[];

  /**
   * Creates the error.
   * @param errors Every missing setting.
   */
  constructor(errors: ConfigError[]) {
    super(errors.map(error => `${error.variable}: ${error.message}`).join('; '));
    this.name = 'ConfigFailure';
    this.errors = errors;
  }
}

/** Outcome of `loadConfig`. */
export type LoadConfigResult = LoadConfigFailure | LoadConfigOk;

/**
 * Converts a zod issue to a config error without leaking the value.
 * @param issue Issue reported by zod.
 * @param input Normalized input that was validated.
 * @returns Error naming the variable.
 */
function toConfigError(issue: z.core.$ZodIssue, input: Readonly<Record<string, string | undefined>>): ConfigError {
  const variable = String(issue.path[0]);
  // The text of invalid_type issues can be replaced by a custom message, so match on the code.
  const missing = issue.code === 'invalid_type' && input[variable] === undefined;

  return { variable,
    message: missing ? 'is required' : issue.message };
}

/**
 * Drops errors that repeat a variable and a text already listed.
 * @param errors Errors in the order they were found.
 * @returns The first of each kind, in the same order.
 */
function uniqueErrors(errors: readonly ConfigError[]): ConfigError[] {
  const seen = new Set<string>();

  return errors.filter((error) => {
    const key = `${error.variable}\u0000${error.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

/** What the Hawk validator accepts as the address of the Telegram channel. */
export const NOTIFY_URL_PATTERN = /^https:\/\/notify\.bot\.codex\.so\/u\/[A-Za-z0-9]+$/u;
const BOT_TOKEN_PATTERN = /^\d+:[\w-]{30,}$/u;

/**
 * Finds what is wrong with the bot token and the notify address of `telegram-delivery`.
 * @param botToken Token as given.
 * @param notifyUrl Notify address as given.
 * @returns One error per variable that is missing or malformed, without its value.
 */
function telegramErrors(botToken: string | undefined, notifyUrl: string | undefined): ConfigError[] {
  const errors: ConfigError[] = [];

  if (botToken === undefined) {
    errors.push({ variable: 'TELEGRAM_BOT_TOKEN',
      message: 'is required for telegram-delivery' });
  } else if (!BOT_TOKEN_PATTERN.test(botToken)) {
    errors.push({ variable: 'TELEGRAM_BOT_TOKEN',
      message: 'must be a bot token: digits, a colon and at least 30 characters' });
  }

  if (notifyUrl === undefined) {
    errors.push({ variable: 'TELEGRAM_NOTIFY_URL',
      message: 'is required for telegram-delivery' });
  } else if (!NOTIFY_URL_PATTERN.test(notifyUrl)) {
    errors.push({ variable: 'TELEGRAM_NOTIFY_URL',
      message: 'must be a notify address of the form https://notify.bot.codex.so/u/<token>' });
  }

  return errors;
}

/** The settings `history` reads: it opens the database file and knows nothing of Hawk. */
export interface HistoryConfig {
  /** Path of the SQLite file. */
  databasePath: string;
  /** Scenarios the statistics cover by default. */
  scenarios: ScenarioName[];
}

/** Successful `loadHistoryConfig` result. */
export interface LoadHistoryConfigOk {
  /** Discriminant. */
  ok: true;
  /** The two settings. */
  config: HistoryConfig;
}

/** Outcome of `loadHistoryConfig`. */
export type LoadHistoryConfigResult = LoadConfigFailure | LoadHistoryConfigOk;

/**
 * Reads only `DATABASE_PATH` and `SCENARIOS`, so `history` works without the Hawk credentials.
 * @param env Raw environment; empty strings count as missing.
 * @returns The two settings or every problem found.
 */
export function loadHistoryConfig(env: Readonly<Record<string, string | undefined>>): LoadHistoryConfigResult {
  const read = (name: 'DATABASE_PATH' | 'SCENARIOS'): string | undefined => env[name] === '' ? undefined : env[name];
  const databasePath = ENV_SHAPE.DATABASE_PATH.safeParse(read('DATABASE_PATH'));
  const scenarios = ENV_SHAPE.SCENARIOS.safeParse(read('SCENARIOS'));
  const errors: ConfigError[] = [];

  if (!databasePath.success) {
    errors.push({ variable: 'DATABASE_PATH',
      message: databasePath.error.issues[0]?.message ?? 'is invalid' });
  }

  if (!scenarios.success) {
    errors.push({ variable: 'SCENARIOS',
      message: scenarios.error.issues[0]?.message ?? 'is invalid' });
  }

  if (!databasePath.success || !scenarios.success) {
    return { ok: false,
      errors };
  }

  return { ok: true,
    config: { databasePath: databasePath.data,
      scenarios: scenarios.data } };
}

/** What `loadConfig` may be told about its caller. */
export interface LoadOptions {
  /** Command about to run; `serve` also needs the settings of the notification scenarios it will start. */
  command?: Command['kind'];
}

/**
 * Finds what `serve` needs for the notification scenarios it will start, so it can be reported with the other errors.
 * @param input Raw variables, empty strings already removed.
 * @returns Missing or malformed settings; empty when the scenarios need nothing or the scenario list is itself invalid.
 */
function serveRequirements(input: Readonly<Record<string, string | undefined>>): ConfigError[] {
  const listed = ENV_SHAPE.SCENARIOS.safeParse(input.SCENARIOS);

  if (!listed.success) {
    return [];
  }

  const scenarios = listed.data;
  const receiverFor = scenarios.includes(CHECK_NOTIFICATION) ? CHECK_NOTIFICATION : scenarios.includes(TELEGRAM_DELIVERY) ? TELEGRAM_DELIVERY : undefined;
  const errors: ConfigError[] = [];

  if (receiverFor !== undefined) {
    if (input.RECEIVER_SECRET === undefined) {
      errors.push({ variable: 'RECEIVER_SECRET',
        message: `is required for ${receiverFor}` });
    }

    if (input.PUBLIC_BASE_URL === undefined && input.TUNNEL_METRICS_URL === undefined) {
      errors.push({ variable: 'PUBLIC_BASE_URL',
        message: `set PUBLIC_BASE_URL or TUNNEL_METRICS_URL for ${receiverFor}` });
    }
  }

  if (scenarios.includes(TELEGRAM_DELIVERY)) {
    errors.push(...telegramErrors(input.TELEGRAM_BOT_TOKEN, input.TELEGRAM_NOTIFY_URL));
  }

  return errors;
}

/**
 * Validates environment variables and builds the configuration.
 * @param env Raw environment; empty strings count as missing.
 * @param options What the caller is about to run.
 * @returns Configuration or all errors found.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>, options: LoadOptions = {}): LoadConfigResult {
  const input: Record<string, string | undefined> = {};

  for (const name of Object.keys(ENV_SHAPE)) {
    const value = env[name];

    input[name] = value === '' ? undefined : value;
  }

  // The checks that compare variables run only when every variable is fine on its own, so one bad value yields one line.
  const fields = fieldsSchema.safeParse(input);
  const parsed = fields.success ? envSchema.safeParse(input) : fields;

  const missing = options.command === 'serve' ? serveRequirements(input) : [];

  if (!parsed.success) {
    return { ok: false,
      errors: uniqueErrors([...parsed.error.issues.map(issue => toConfigError(issue, input)), ...missing]) };
  }

  if (missing.length > 0) {
    return { ok: false,
      errors: uniqueErrors(missing) };
  }

  const values = parsed.data;

  return {
    ok: true,
    env: values,
    config: {
      instanceId: values.INSTANCE_ID,
      logLevel: values.LOG_LEVEL,
      internal: { host: values.INTERNAL_HOST,
        port: values.INTERNAL_PORT },
      shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
      healthCheckTimeoutMs: values.HEALTH_CHECK_TIMEOUT_MS,
      hawk: {
        apiUrl: values.HAWK_API_URL,
        collectorUrl: values.HAWK_COLLECTOR_URL,
        integrationToken: values.HAWK_INTEGRATION_TOKEN,
        ...values.GARAGE_URL === undefined ? {} : { garageUrl: values.GARAGE_URL },
        projectId: values.HAWK_PROJECT_ID,
        email: values.HAWK_EMAIL,
        password: values.HAWK_PASSWORD,
      },
      transportMode: values.TRANSPORT_MODE,
      repeatEveryNRuns: values.REPEAT_EVERY_N_RUNS,
      httpTimeoutMs: values.HTTP_TIMEOUT_MS,
      retry: { attempts: values.RETRY_ATTEMPTS,
        delaysMs: values.RETRY_DELAYS_MS },
      lateDuplicateWaitMs: values.LATE_DUPLICATE_WAIT_MS,
      timeouts: {
        collectorAvailability: values.COLLECTOR_AVAILABILITY_TIMEOUT_MS,
        apiAvailability: values.API_AVAILABILITY_TIMEOUT_MS,
        collectorAccept: values.COLLECTOR_ACCEPT_TIMEOUT_MS,
        eventVisible: values.EVENT_VISIBLE_TIMEOUT_MS,
        eventRepeated: values.EVENT_REPEATED_TIMEOUT_MS,
        cleanup: values.CLEANUP_TIMEOUT_MS,
        garage: values.GARAGE_TIMEOUT_MS,
        run: values.RUN_TIMEOUT_MS,
      },
      notifications: {
        receiverHost: values.RECEIVER_HOST,
        receiverPort: values.RECEIVER_PORT,
        ...values.RECEIVER_SECRET === undefined ? {} : { receiverSecret: values.RECEIVER_SECRET },
        ...values.PUBLIC_BASE_URL === undefined ? {} : { publicBaseUrl: values.PUBLIC_BASE_URL },
        ...values.TUNNEL_METRICS_URL === undefined ? {} : { tunnelMetricsUrl: values.TUNNEL_METRICS_URL },
        loop: values.NOTIFY_LOOP,
        timeoutMs: values.NOTIFICATION_TIMEOUT_MS,
        pairWaitMs: values.NOTIFICATION_PAIR_WAIT_MS,
        setupTimeoutMs: values.NOTIFICATION_SETUP_TIMEOUT_MS,
        ruleCacheWarmupMs: values.RULE_CACHE_WARMUP_MS,
      },
      monitoring: {
        scenarios: values.SCENARIOS,
        intervalMs: values.CHECK_INTERVAL_MS,
        watchdogGraceMs: values.WATCHDOG_GRACE_MS,
        staggerMs: values.SCENARIO_STAGGER_MS,
        tunnelReadyTimeoutMs: values.TUNNEL_READY_TIMEOUT_MS,
        databasePath: values.DATABASE_PATH,
        retentionDays: values.HISTORY_RETENTION_DAYS,
        ...values.ALERT_NOTIFY_URL === undefined ? {} : { alertNotifyUrl: values.ALERT_NOTIFY_URL },
        alertAfterFailures: values.ALERT_AFTER_FAILURES,
        alertRetryMs: values.ALERT_RETRY_MS,
        sweepIntervalMs: values.SWEEP_INTERVAL_MS,
        sweepMinAgeMs: values.SWEEP_MIN_AGE_MS,
        heartbeat: { ...values.HEARTBEAT_URL === undefined ? {} : { url: values.HEARTBEAT_URL },
          intervalMs: values.HEARTBEAT_INTERVAL_MS },
        manual: { ...values.RUN_TOKEN === undefined ? {} : { token: values.RUN_TOKEN },
          minIntervalMs: values.MANUAL_MIN_INTERVAL_MS },
        probe: { intervalMs: values.PROBE_INTERVAL_MS,
          alertAfterFailures: values.PROBE_ALERT_AFTER_FAILURES,
          retentionDays: values.PROBE_RETENTION_DAYS },
      },
      scenarios: {
        newProject: { intervalMs: values.NEW_PROJECT_INTERVAL_MS,
          tokenTimeoutMs: values.NEW_PROJECT_TOKEN_TIMEOUT_MS },
        sourcemaps: { intervalMs: values.SOURCEMAPS_INTERVAL_MS,
          releaseSaveTimeoutMs: values.RELEASE_SAVE_TIMEOUT_MS },
        sentryEnvelope: { intervalMs: values.SENTRY_ENVELOPE_INTERVAL_MS },
        telegramDelivery: {
          intervalMs: values.TELEGRAM_DELIVERY_INTERVAL_MS,
          ...values.TELEGRAM_BOT_TOKEN === undefined ? {} : { botToken: values.TELEGRAM_BOT_TOKEN },
          ...values.TELEGRAM_NOTIFY_URL === undefined ? {} : { notifyUrl: values.TELEGRAM_NOTIFY_URL },
          ...values.TELEGRAM_CHAT_ID === undefined ? {} : { chatId: values.TELEGRAM_CHAT_ID },
          senderUsername: values.TELEGRAM_SENDER_USERNAME,
          apiUrl: values.TELEGRAM_API_URL,
          deliveryTimeoutMs: values.TELEGRAM_DELIVERY_TIMEOUT_MS,
          probeTimeoutMs: values.TELEGRAM_PROBE_TIMEOUT_MS,
        },
      },
    },
  };
}

/**
 * Formats config errors as the text printed to stderr on startup failure.
 * @param errors Errors from `loadConfig`, printed in the given order.
 * @returns Multi-line text ending with a newline.
 */
export function formatConfigErrors(errors: readonly ConfigError[]): string {
  const lines = errors.map(error => `  ${error.variable}: ${error.message}`);

  return ['Invalid configuration:', ...lines, 'See .env.example for all variables.'].join('\n') + '\n';
}

/**
 * Checks the settings that only the notification commands need.
 * @param config Loaded configuration.
 * @returns The notification settings with the secret present.
 * @throws ConfigFailure when the secret or both address sources are missing.
 */
export function notificationSettings(config: Config): NotificationConfig & Required<Pick<NotificationConfig, 'receiverSecret'>> {
  const { notifications } = config;
  const errors: ConfigError[] = [];

  if (notifications.receiverSecret === undefined) {
    errors.push({ variable: 'RECEIVER_SECRET',
      message: 'is required for this command' });
  }

  if (notifications.publicBaseUrl === undefined && notifications.tunnelMetricsUrl === undefined) {
    errors.push({ variable: 'PUBLIC_BASE_URL',
      message: 'set PUBLIC_BASE_URL or TUNNEL_METRICS_URL' });
  }

  if (notifications.receiverSecret === undefined || errors.length > 0) {
    throw new ConfigFailure(errors);
  }

  return { ...notifications,
    receiverSecret: notifications.receiverSecret };
}

/**
 * Checks the settings that only a chosen `telegram-delivery` needs.
 * @param config Loaded configuration.
 * @returns The Telegram settings with the token and the notify URL present and well formed.
 * @throws ConfigFailure naming each variable that is missing or malformed, without its value.
 */
export function telegramSettings(config: Config): TelegramDeliveryConfig & Required<Pick<TelegramDeliveryConfig, 'botToken' | 'notifyUrl'>> {
  const settings = config.scenarios.telegramDelivery;
  const { botToken, notifyUrl } = settings;
  const errors = telegramErrors(botToken, notifyUrl);

  if (botToken === undefined || notifyUrl === undefined || errors.length > 0) {
    throw new ConfigFailure(errors);
  }

  return { ...settings,
    botToken,
    notifyUrl };
}
