import { z } from 'zod';
import { decodeIntegrationToken } from '../hawk/token.js';
import { durationMs } from './duration.js';

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

/** Stage time limits, as environment variable and the key `Config.budgets` stores it under. */
export const STAGE_TIMEOUT_VARS = [
  ['COLLECTOR_AVAILABILITY_TIMEOUT_MS', 'collectorAvailability'],
  ['API_AVAILABILITY_TIMEOUT_MS', 'apiAvailability'],
  ['COLLECTOR_ACCEPT_TIMEOUT_MS', 'collectorAccept'],
  ['EVENT_VISIBLE_TIMEOUT_MS', 'eventVisible'],
  ['EVENT_REPEATED_TIMEOUT_MS', 'eventRepeated'],
  ['CLEANUP_TIMEOUT_MS', 'cleanup'],
] as const;

/**
 * Builds the schema for an http(s) URL variable.
 * @returns URL schema with a fixed error message.
 */
function httpUrl(): z.ZodURL {
  return z.url({ protocol: /^https?$/,
    message: 'must be an http(s) URL' });
}

/** Schemas of all environment variables, in the order errors are reported. */
export const ENV_SHAPE = {
  INSTANCE_ID: pub(z.string().regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 characters: a-z, 0-9, -')
    // The grouper masks values that look like card numbers (13-19 digits).
    .refine(value => value.replaceAll(/\D/gu, '').length <= MAX_INSTANCE_DIGITS, 'must contain at most 12 digits')),
  LOG_LEVEL: pub(z.enum(LOG_LEVELS).default('info')),
  INTERNAL_HOST: pub(z.string().min(1)
    .default('127.0.0.1')),
  INTERNAL_PORT: pub(
    z.string()
      .regex(/^\d+$/, PORT_MESSAGE)
      .transform(Number)
      .pipe(z.number().int()
        .min(1, PORT_MESSAGE)
        .max(MAX_PORT, PORT_MESSAGE))
      .default(DEFAULT_INTERNAL_PORT)
  ),
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
  LATE_DUPLICATE_WAIT_MS: pub(durationMs(DEFAULT_LATE_DUPLICATE_WAIT_MS, { allowZero: true })),
  RUN_TIMEOUT_MS: pub(durationMs(DEFAULT_RUN_TIMEOUT_MS)),
};

/**
 * Checks that depend on several variables.
 * Zod also runs it when a field failed a format rule, so it skips itself when the values it needs are unusable.
 * @param env Parsed variables.
 * @param ctx Collects the issues.
 */
function checkCombinations(env: z.output<typeof baseSchema>, ctx: z.RefinementCtx): void {
  // Zod runs this check even when a field failed a format rule, so skip values that are not usable.
  const numbers = ['HTTP_TIMEOUT_MS', 'RUN_TIMEOUT_MS', 'LATE_DUPLICATE_WAIT_MS', ...STAGE_TIMEOUT_VARS.map(([name]) => name)] as const;

  if (!URL.canParse(env.HAWK_API_URL) || numbers.some(name => typeof env[name] !== 'number')) {
    return;
  }

  // After the wait cleanup reads the card once and removes the event in up to three attempts.
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
