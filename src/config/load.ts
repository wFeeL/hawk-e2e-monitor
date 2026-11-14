import type { z } from 'zod';
import { ENV_SHAPE, envSchema } from './schema.js';
import type { LogLevel, ParsedEnv, TransportMode } from './schema.js';

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
  /** Id of the monitored project. */
  projectId: string;
  /** Login of the account that reads the project. */
  email: string;
  /** Password of that account. */
  password: string;
}

/** Time limits of the stages and of the whole run. */
export interface StageBudgets {
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
  /** Pause before cleanup rechecks the event count; 0 turns it off. */
  lateDuplicateWaitMs: number;
  /** Time limits of the stages and the run. */
  budgets: StageBudgets;
  /** Notification receiver and public address. */
  notifications: NotificationConfig;
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
 * Validates environment variables and builds the configuration.
 * @param env Raw environment; empty strings count as missing.
 * @returns Configuration or all errors found.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): LoadConfigResult {
  const input: Record<string, string | undefined> = {};

  for (const name of Object.keys(ENV_SHAPE)) {
    const value = env[name];

    input[name] = value === '' ? undefined : value;
  }

  const parsed = envSchema.safeParse(input);

  if (!parsed.success) {
    return { ok: false,
      errors: parsed.error.issues.map(issue => toConfigError(issue, input)) };
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
        projectId: values.HAWK_PROJECT_ID,
        email: values.HAWK_EMAIL,
        password: values.HAWK_PASSWORD,
      },
      transportMode: values.TRANSPORT_MODE,
      repeatEveryNRuns: values.REPEAT_EVERY_N_RUNS,
      httpTimeoutMs: values.HTTP_TIMEOUT_MS,
      lateDuplicateWaitMs: values.LATE_DUPLICATE_WAIT_MS,
      budgets: {
        collectorAvailability: values.COLLECTOR_AVAILABILITY_TIMEOUT_MS,
        apiAvailability: values.API_AVAILABILITY_TIMEOUT_MS,
        collectorAccept: values.COLLECTOR_ACCEPT_TIMEOUT_MS,
        eventVisible: values.EVENT_VISIBLE_TIMEOUT_MS,
        eventRepeated: values.EVENT_REPEATED_TIMEOUT_MS,
        cleanup: values.CLEANUP_TIMEOUT_MS,
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
