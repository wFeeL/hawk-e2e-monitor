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
  /** Time limits of the stages and the run. */
  budgets: StageBudgets;
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
      budgets: {
        collectorAvailability: values.COLLECTOR_AVAILABILITY_TIMEOUT_MS,
        apiAvailability: values.API_AVAILABILITY_TIMEOUT_MS,
        collectorAccept: values.COLLECTOR_ACCEPT_TIMEOUT_MS,
        eventVisible: values.EVENT_VISIBLE_TIMEOUT_MS,
        eventRepeated: values.EVENT_REPEATED_TIMEOUT_MS,
        cleanup: values.CLEANUP_TIMEOUT_MS,
        run: values.RUN_TIMEOUT_MS,
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
