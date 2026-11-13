import { z } from 'zod';
import { durationMs } from './duration.js';

const DEFAULT_INTERNAL_PORT = 8090;
const MAX_PORT = 65_535;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2000;
const PORT_MESSAGE = 'must be a port number from 1 to 65535';

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
  INSTANCE_ID: pub(z.string().regex(/^[a-z0-9-]{1,32}$/, 'must be 1-32 characters: a-z, 0-9, -')),
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
    .regex(/^\S+$/, 'must not contain whitespace'),
  HAWK_PROJECT_ID: pub(z.string().min(1)),
  HAWK_EMAIL: pub(z.email({ message: 'must be an email address' })),
  HAWK_PASSWORD: z.string().min(1),
};

/** Schema of the whole environment. */
export const envSchema = z.object(ENV_SHAPE);

/** Environment after validation and defaults. */
export type ParsedEnv = z.output<typeof envSchema>;
