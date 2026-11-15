import { z } from 'zod';
import { decodeIntegrationToken } from '../hawk/token.js';
import { blockedPortOf } from '../net/blocked-ports.js';
import { CHECK_NOTIFICATION, SCENARIO_NAMES, SEND_AND_RECEIVE_EVENT } from '../scenarios/names.js';
import { boundedDurationMs, durationMs } from './duration.js';

const DEFAULT_INTERNAL_PORT = 8090;
const MAX_PORT = 65_535;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2000;
const DEFAULT_HTTP_TIMEOUT_MS = 5000;
const DEFAULT_AVAILABILITY_TIMEOUT_MS = 15_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 10_000;
const DEFAULT_VISIBLE_TIMEOUT_MS = 120_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_LATE_DUPLICATE_WAIT_MS = 5000;
const DEFAULT_RUN_TIMEOUT_MS = 480_000;
const DEFAULT_RECEIVER_PORT = 8091;
const DEFAULT_NOTIFICATION_TIMEOUT_MS = 120_000;
const DEFAULT_NOTIFICATION_PAIR_WAIT_MS = 15_000;
const DEFAULT_NOTIFICATION_SETUP_TIMEOUT_MS = 30_000;
const DEFAULT_RULE_CACHE_WARMUP_MS = 65_000;
const DEFAULT_CHECK_INTERVAL_MS = 600_000;
const DEFAULT_WATCHDOG_GRACE_MS = 30_000;
const MIN_WATCHDOG_GRACE_MS = 1000;
const MAX_WATCHDOG_GRACE_MS = 600_000;
const DEFAULT_STAGGER_MS = 30_000;
const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 120_000;
const MAX_TUNNEL_READY_TIMEOUT_MS = 600_000;
const DEFAULT_DATABASE_PATH = 'data/monitor.db';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_ALERT_AFTER_FAILURES = 1;
const MAX_ALERT_AFTER_FAILURES = 10;
const DEFAULT_ALERT_RETRY_MS = 60_000;
const MIN_ALERT_RETRY_MS = 1000;
const MAX_ALERT_RETRY_MS = 3_600_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const MAX_RETRY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAYS = '200,500';
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 3_600_000;
const DEFAULT_SWEEP_MIN_AGE_MS = 900_000;
const RECEIVER_SECRET_PATTERN = /^[\w-]{32,}$/;
const DEFAULT_REPEAT_EVERY_N_RUNS = 6;
const MAX_INSTANCE_DIGITS = 12;
const CLEANUP_REQUESTS = 4;
const PROJECT_ID_PATTERN = /^[0-9a-f]{24}$/;
const PORT_MESSAGE = 'must be a port number from 1 to 65535';
const REPEAT_MESSAGE = 'must be a whole number, 0 or more';

/** Registry metadata of a variable that is safe to print. */
export interface PublicMeta {
  /** Always true: unregistered variables are masked. */
  public: true;
}

/** Variables whose values may appear in the startup summary; all others are masked. */
export const publicVars = z.registry<PublicMeta>();

/**
 * Marks a variable schema as safe to print.
 * Registers the exact instance, so wrap the outermost schema (after `.optional()` and `.default()`).
 * @param schema Outermost schema of the variable.
 * @returns The same schema.
 */
export function pub<T extends z.ZodType>(schema: T): T {
  publicVars.add(schema, { public: true });

  return schema;
}

/** Log levels from the least to the most severe. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

/** One of `LOG_LEVELS`. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Ways to pick the transport of a run. */
export const TRANSPORT_MODES = ['alternate', 'http', 'ws'] as const;

/** One of `TRANSPORT_MODES`. */
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Stage time limits, as environment variable and the key `Config.timeouts` stores it under. */
export const STAGE_TIMEOUT_VARS = [
  ['COLLECTOR_AVAILABILITY_TIMEOUT_MS', 'collectorAvailability'],
  ['API_AVAILABILITY_TIMEOUT_MS', 'apiAvailability'],
  ['COLLECTOR_ACCEPT_TIMEOUT_MS', 'collectorAccept'],
  ['EVENT_VISIBLE_TIMEOUT_MS', 'eventVisible'],
  ['EVENT_REPEATED_TIMEOUT_MS', 'eventRepeated'],
  ['CLEANUP_TIMEOUT_MS', 'cleanup'],
] as const;

/**
 * Rejects a URL whose port `fetch` refuses to connect to, so the mistake shows at startup.
 * @param value Address that already passed the URL check.
 * @param ctx Collects the issue.
 */
function rejectBlockedPort(value: string, ctx: z.RefinementCtx): void {
  const port = blockedPortOf(value);

  if (port !== undefined) {
    ctx.addIssue({ code: 'custom',
      message: `uses port ${String(port)}, which fetch blocks; pick another port` });
  }
}

/**
 * Builds the schema for an http(s) URL variable.
 * @returns URL schema with a fixed error message.
 */
function httpUrl(): z.ZodType<string> {
  return z.url({ protocol: /^https?$/,
    message: 'must be an http(s) URL' }).superRefine(rejectBlockedPort);
}

/**
 * Builds the schema for a TCP port variable.
 * @param defaultPort Value used when the variable is not set.
 * @returns Port schema with a fixed error message.
 */
function portVar(defaultPort: number): z.ZodType<number> {
  return z.string()
    .regex(/^\d+$/, PORT_MESSAGE)
    .transform(Number)
    .pipe(z.number().int()
      .min(1, PORT_MESSAGE)
      .max(MAX_PORT, PORT_MESSAGE))
    .default(defaultPort);
}

/**
 * Tells whether a value is an https origin the notifier can reach.
 * @param value Raw variable value.
 * @returns True for https, no userinfo, path, query or hash, and port 443 or none.
 */
function isPublicBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);

  return url.protocol === 'https:' && url.pathname === '/' && url.port === ''
    && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}

/**
 * Builds the schema for a whole number in a range.
 * @param defaultValue Value used when the variable is not set.
 * @param min Lowest accepted value.
 * @param max Highest accepted value.
 * @returns Integer schema with a fixed error message.
 */
function intRange(defaultValue: number, min: number, max: number): z.ZodType<number> {
  const message = `must be a whole number from ${String(min)} to ${String(max)}`;

  return z.string()
    .regex(/^\d+$/, message)
    .transform(Number)
    .pipe(z.number().int()
      .min(min, message)
      .max(max, message))
    .default(defaultValue);
}

/**
 * Builds the schema of the scenario list: names separated by commas, each at most once.
 * @returns Schema that outputs the names in the order given.
 */
function scenarioList(): z.ZodType<Array<(typeof SCENARIO_NAMES)[number]>> {
  const names = SCENARIO_NAMES.join(', ');

  return z.string()
    .default(SEND_AND_RECEIVE_EVENT)
    .transform(value => value.split(',').map(name => name.trim()))
    .pipe(z.array(z.enum(SCENARIO_NAMES, { message: `must be a comma-separated list of: ${names}` }))
      .refine(list => new Set(list).size === list.length, 'must not repeat a scenario'));
}

/**
 * Builds the schema of the pauses between attempts: whole milliseconds separated by commas.
 * @returns Schema that outputs the pauses in the order given; an empty value means no pauses.
 */
function retryDelays(): z.ZodType<number[]> {
  const message = `must be comma-separated whole milliseconds from 0 to ${String(MAX_RETRY_DELAY_MS)}`;

  return z.string()
    .default(DEFAULT_RETRY_DELAYS)
    .transform(value => value.trim() === '' ? [] : value.split(',').map(part => part.trim()))
    .pipe(z.array(z.string().regex(/^\d+$/, message)
      .transform(Number)
      .pipe(z.number().max(MAX_RETRY_DELAY_MS, message))));
}

/** Schemas of all environment variables, in the order errors are reported. */
export const ENV_SHAPE = {
  INSTANCE_ID: pub(z.string().regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 characters: a-z, 0-9, -')
    // The grouper masks values that look like card numbers (13-19 digits).
    .refine(value => value.replaceAll(/\D/gu, '').length <= MAX_INSTANCE_DIGITS, 'must contain at most 12 digits')
    // The title of this scenario's events must not match the other scenario's events.
    .refine(value => !value.toLowerCase().includes(SEND_AND_RECEIVE_EVENT), `must not contain "${SEND_AND_RECEIVE_EVENT}"`)),
  LOG_LEVEL: pub(z.enum(LOG_LEVELS).default('info')),
  INTERNAL_HOST: pub(z.string().min(1)
    .default('127.0.0.1')),
  INTERNAL_PORT: pub(portVar(DEFAULT_INTERNAL_PORT)),
  SHUTDOWN_TIMEOUT_MS: pub(durationMs(DEFAULT_SHUTDOWN_TIMEOUT_MS)),
  HEALTH_CHECK_TIMEOUT_MS: pub(durationMs(DEFAULT_HEALTH_CHECK_TIMEOUT_MS)),
  HAWK_API_URL: pub(httpUrl()),
  HAWK_COLLECTOR_URL: pub(httpUrl().optional()),
  HAWK_INTEGRATION_TOKEN: z.string().min(1)
    .regex(/^\S+$/, 'must not contain whitespace')
    .refine(value => decodeIntegrationToken(value) !== undefined,
      'must be a Hawk integration token (base64 JSON with integrationId and secret)'),
  HAWK_PROJECT_ID: pub(z.string().regex(PROJECT_ID_PATTERN, 'must be a 24-character hex id')),
  HAWK_EMAIL: pub(z.email({ message: 'must be an email address' })),
  HAWK_PASSWORD: z.string().min(1),
  TRANSPORT_MODE: pub(z.enum(TRANSPORT_MODES).default('alternate')),
  REPEAT_EVERY_N_RUNS: pub(
    z.string()
      .regex(/^\d+$/, REPEAT_MESSAGE)
      .transform(Number)
      .pipe(z.number(REPEAT_MESSAGE).int(REPEAT_MESSAGE)
        .min(0, REPEAT_MESSAGE))
      .default(DEFAULT_REPEAT_EVERY_N_RUNS)
  ),
  HTTP_TIMEOUT_MS: pub(durationMs(DEFAULT_HTTP_TIMEOUT_MS)),
  COLLECTOR_AVAILABILITY_TIMEOUT_MS: pub(durationMs(DEFAULT_AVAILABILITY_TIMEOUT_MS)),
  API_AVAILABILITY_TIMEOUT_MS: pub(durationMs(DEFAULT_AVAILABILITY_TIMEOUT_MS)),
  COLLECTOR_ACCEPT_TIMEOUT_MS: pub(durationMs(DEFAULT_ACCEPT_TIMEOUT_MS)),
  EVENT_VISIBLE_TIMEOUT_MS: pub(durationMs(DEFAULT_VISIBLE_TIMEOUT_MS)),
  EVENT_REPEATED_TIMEOUT_MS: pub(durationMs(DEFAULT_VISIBLE_TIMEOUT_MS)),
  CLEANUP_TIMEOUT_MS: pub(durationMs(DEFAULT_CLEANUP_TIMEOUT_MS)),
  RETRY_ATTEMPTS: pub(intRange(DEFAULT_RETRY_ATTEMPTS, 1, MAX_RETRY_ATTEMPTS)),
  RETRY_DELAYS_MS: pub(retryDelays()),
  LATE_DUPLICATE_WAIT_MS: pub(durationMs(DEFAULT_LATE_DUPLICATE_WAIT_MS, { allowZero: true })),
  RUN_TIMEOUT_MS: pub(durationMs(DEFAULT_RUN_TIMEOUT_MS)),
  RECEIVER_HOST: pub(z.string().min(1)
    .default('127.0.0.1')),
  RECEIVER_PORT: pub(portVar(DEFAULT_RECEIVER_PORT)),
  RECEIVER_SECRET: z.string().regex(RECEIVER_SECRET_PATTERN, 'must be at least 32 characters: A-Z, a-z, 0-9, _ and -')
    .optional(),
  PUBLIC_BASE_URL: z.string().refine(isPublicBaseUrl, 'must be an https address without a path, on port 443')
    .optional(),
  TUNNEL_METRICS_URL: httpUrl().optional(),
  NOTIFY_LOOP: pub(z.enum(['true', 'false'], { message: 'must be true or false' })
    .transform(value => value === 'true')
    .default(true)),
  NOTIFICATION_TIMEOUT_MS: pub(durationMs(DEFAULT_NOTIFICATION_TIMEOUT_MS)),
  NOTIFICATION_PAIR_WAIT_MS: pub(durationMs(DEFAULT_NOTIFICATION_PAIR_WAIT_MS)),
  NOTIFICATION_SETUP_TIMEOUT_MS: pub(durationMs(DEFAULT_NOTIFICATION_SETUP_TIMEOUT_MS)),
  RULE_CACHE_WARMUP_MS: pub(durationMs(DEFAULT_RULE_CACHE_WARMUP_MS)),
  SCENARIOS: pub(scenarioList()),
  CHECK_INTERVAL_MS: pub(durationMs(DEFAULT_CHECK_INTERVAL_MS)),
  WATCHDOG_GRACE_MS: pub(boundedDurationMs(DEFAULT_WATCHDOG_GRACE_MS, MIN_WATCHDOG_GRACE_MS, MAX_WATCHDOG_GRACE_MS)),
  SCENARIO_STAGGER_MS: pub(durationMs(DEFAULT_STAGGER_MS, { allowZero: true })),
  TUNNEL_READY_TIMEOUT_MS: pub(boundedDurationMs(DEFAULT_TUNNEL_READY_TIMEOUT_MS, 0, MAX_TUNNEL_READY_TIMEOUT_MS)),
  DATABASE_PATH: pub(z.string().min(1)
    .default(DEFAULT_DATABASE_PATH)),
  HISTORY_RETENTION_DAYS: pub(intRange(DEFAULT_RETENTION_DAYS, 1, MAX_RETENTION_DAYS)),
  // The URL carries the chat token, so the variable is not registered as public.
  ALERT_NOTIFY_URL: z.url({ protocol: /^https$/,
    message: 'must be an https URL' }).superRefine(rejectBlockedPort)
    .optional(),
  ALERT_AFTER_FAILURES: pub(intRange(DEFAULT_ALERT_AFTER_FAILURES, 1, MAX_ALERT_AFTER_FAILURES)),
  ALERT_RETRY_MS: pub(boundedDurationMs(DEFAULT_ALERT_RETRY_MS, MIN_ALERT_RETRY_MS, MAX_ALERT_RETRY_MS)),
  SWEEP_INTERVAL_MS: pub(durationMs(DEFAULT_SWEEP_INTERVAL_MS, { allowZero: true })),
  SWEEP_MIN_AGE_MS: pub(durationMs(DEFAULT_SWEEP_MIN_AGE_MS)),
};

/**
 * Checks the timeouts of the check-notification scenario against each other.
 * @param env Parsed variables with usable numbers.
 * @param ctx Collects the issues.
 */
function checkNotificationTimeout(env: z.output<typeof baseSchema>, ctx: z.RefinementCtx): void {
  if (env.NOTIFICATION_PAIR_WAIT_MS >= env.NOTIFICATION_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['NOTIFICATION_PAIR_WAIT_MS'],
      message: 'must be less than NOTIFICATION_TIMEOUT_MS' });
  }

  if (env.HTTP_TIMEOUT_MS >= env.NOTIFICATION_SETUP_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['HTTP_TIMEOUT_MS'],
      message: 'must be less than NOTIFICATION_SETUP_TIMEOUT_MS' });
  }

  const total = env.COLLECTOR_AVAILABILITY_TIMEOUT_MS + env.API_AVAILABILITY_TIMEOUT_MS + env.NOTIFICATION_SETUP_TIMEOUT_MS
    + env.COLLECTOR_ACCEPT_TIMEOUT_MS
    + Math.max(env.EVENT_VISIBLE_TIMEOUT_MS, env.NOTIFICATION_TIMEOUT_MS + env.HTTP_TIMEOUT_MS)
    + env.EVENT_REPEATED_TIMEOUT_MS;

  if (total > env.RUN_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['RUN_TIMEOUT_MS'],
      message: `must be at least the sum of the timeouts of the check-notification stages (${String(total)} ms)` });
  }
}

/**
 * Checks the retry policy against itself and against the shortest timeout that contains retries.
 * @param env Parsed variables with usable numbers.
 * @param ctx Collects the issues.
 */
function checkRetry(env: z.output<typeof baseSchema>, ctx: z.RefinementCtx): void {
  // A single attempt never pauses, so the list is not used and not checked.
  if (env.RETRY_ATTEMPTS === 1) {
    return;
  }

  if (env.RETRY_DELAYS_MS.length !== env.RETRY_ATTEMPTS - 1) {
    ctx.addIssue({ code: 'custom',
      path: ['RETRY_DELAYS_MS'],
      message: `must list one pause fewer than RETRY_ATTEMPTS: ${String(env.RETRY_ATTEMPTS)} attempts need a list of ${String(env.RETRY_ATTEMPTS - 1)}, got ${String(env.RETRY_DELAYS_MS.length)}` });

    return;
  }

  const pauses = env.RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
  const [shortestName, shortest] = [...STAGE_TIMEOUT_VARS.map(([name]) => name), 'NOTIFICATION_SETUP_TIMEOUT_MS' as const]
    .map(name => [name, env[name]] as const)
    .reduce((least, entry) => entry[1] < least[1] ? entry : least);

  if (pauses > shortest) {
    ctx.addIssue({ code: 'custom',
      path: ['RETRY_DELAYS_MS'],
      message: `pauses add up to ${String(pauses)} ms, more than ${shortestName} (${String(shortest)} ms), the shortest timeout that contains retries; shorten RETRY_DELAYS_MS or lower RETRY_ATTEMPTS` });
  }
}

/**
 * Checks the scheduling variables of the continuous monitoring against each other.
 * @param env Parsed variables with usable numbers.
 * @param ctx Collects the issues.
 */
function checkMonitoring(env: z.output<typeof baseSchema>, ctx: z.RefinementCtx): void {
  const runAndCleanup = env.RUN_TIMEOUT_MS + env.CLEANUP_TIMEOUT_MS;
  const watchdog = runAndCleanup + env.WATCHDOG_GRACE_MS;

  if (env.CHECK_INTERVAL_MS <= watchdog) {
    ctx.addIssue({ code: 'custom',
      path: ['CHECK_INTERVAL_MS'],
      message: `must be greater than RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + WATCHDOG_GRACE_MS (${String(watchdog)} ms)` });
  }

  if (env.SCENARIO_STAGGER_MS > env.CHECK_INTERVAL_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['SCENARIO_STAGGER_MS'],
      message: 'must not exceed CHECK_INTERVAL_MS' });
  }

  if (env.SWEEP_MIN_AGE_MS < runAndCleanup) {
    ctx.addIssue({ code: 'custom',
      path: ['SWEEP_MIN_AGE_MS'],
      message: `must be at least RUN_TIMEOUT_MS + CLEANUP_TIMEOUT_MS (${String(runAndCleanup)} ms)` });
  }

  if (!Array.isArray(env.SCENARIOS) || !env.SCENARIOS.includes(CHECK_NOTIFICATION)) {
    return;
  }

  if (env.RECEIVER_SECRET === undefined) {
    ctx.addIssue({ code: 'custom',
      path: ['SCENARIOS'],
      message: 'check-notification needs RECEIVER_SECRET' });
  }

  if (env.PUBLIC_BASE_URL === undefined && env.TUNNEL_METRICS_URL === undefined) {
    ctx.addIssue({ code: 'custom',
      path: ['SCENARIOS'],
      message: 'check-notification needs PUBLIC_BASE_URL or TUNNEL_METRICS_URL' });
  }
}

/**
 * Checks that depend on several variables.
 * Zod also runs it when a field failed a format rule, so it skips itself when the values it needs are unusable.
 * @param env Parsed variables.
 * @param ctx Collects the issues.
 */
function checkCombinations(env: z.output<typeof baseSchema>, ctx: z.RefinementCtx): void {
  // Zod runs this check even when a field failed a format rule, so skip values that are not usable.
  const numbers = ['HTTP_TIMEOUT_MS', 'RUN_TIMEOUT_MS', 'LATE_DUPLICATE_WAIT_MS', ...STAGE_TIMEOUT_VARS.map(([name]) => name),
    'NOTIFICATION_TIMEOUT_MS', 'NOTIFICATION_PAIR_WAIT_MS', 'NOTIFICATION_SETUP_TIMEOUT_MS',
    'CHECK_INTERVAL_MS', 'WATCHDOG_GRACE_MS', 'SCENARIO_STAGGER_MS', 'SWEEP_MIN_AGE_MS', 'RETRY_ATTEMPTS'] as const;

  if (!URL.canParse(env.HAWK_API_URL) || numbers.some(name => typeof env[name] !== 'number') || !Array.isArray(env.RETRY_DELAYS_MS)) {
    return;
  }

  // After the wait cleanup reads the card once, capped at one HTTP timeout, then removes the event in up to three attempts.
  const cleanupNeeds = env.LATE_DUPLICATE_WAIT_MS + CLEANUP_REQUESTS * env.HTTP_TIMEOUT_MS;

  if (cleanupNeeds > env.CLEANUP_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['LATE_DUPLICATE_WAIT_MS'],
      message: `must leave room for the recheck and removal: LATE_DUPLICATE_WAIT_MS + 4 * HTTP_TIMEOUT_MS must not exceed CLEANUP_TIMEOUT_MS (${String(cleanupNeeds)} ms)` });
  }

  let stagesTotal = 0;

  for (const [name] of STAGE_TIMEOUT_VARS) {
    if (env.HTTP_TIMEOUT_MS >= env[name]) {
      ctx.addIssue({ code: 'custom',
        path: ['HTTP_TIMEOUT_MS'],
        message: `must be less than ${name}` });
    }
  }

  for (const [name] of STAGE_TIMEOUT_VARS.slice(0, -1)) {
    stagesTotal += env[name];
  }

  if (stagesTotal > env.RUN_TIMEOUT_MS) {
    ctx.addIssue({ code: 'custom',
      path: ['RUN_TIMEOUT_MS'],
      message: `must be at least the sum of the timeouts of stages 1-5 (${String(stagesTotal)} ms)` });
  }

  checkRetry(env, ctx);
  checkNotificationTimeout(env, ctx);
  checkMonitoring(env, ctx);

  const hostname = new URL(env.HAWK_API_URL).hostname;
  const production = hostname === 'hawk.so' || hostname.endsWith('.hawk.so');

  if (env.HAWK_COLLECTOR_URL === undefined && !production) {
    ctx.addIssue({ code: 'custom',
      path: ['HAWK_COLLECTOR_URL'],
      message: 'must be set when HAWK_API_URL is not a hawk.so host' });
  }
}

const baseSchema = z.object(ENV_SHAPE);

/** Schema of the whole environment. */
export const envSchema = baseSchema.superRefine(checkCombinations);

/** Environment after validation and defaults. */
export type ParsedEnv = z.output<typeof envSchema>;
