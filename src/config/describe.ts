import type { z } from 'zod';
import { CHECK_NOTIFICATION } from '../scenarios/names.js';
import { ENV_SHAPE, publicVars } from './schema.js';
import type { ParsedEnv } from './schema.js';

/** Configuration summary safe to write to logs. */
export interface ConfigSummary {
  /** Value of every variable in its own type: public values as parsed, `***` for secrets, `(unset)` for missing ones. */
  values: Record<string, unknown>;
  /** Human-readable notes about risky combinations. */
  warnings: string[];
}

/**
 * Removes credentials from a URL string; other strings pass through unchanged.
 * @param text Value to print.
 * @returns Text without URL userinfo.
 */
function stripUserinfo(text: string): string {
  if (!URL.canParse(text)) {
    return text;
  }

  const url = new URL(text);

  if (url.username === '' && url.password === '') {
    return text;
  }

  url.username = '';
  url.password = '';

  return url.toString();
}

/**
 * Prints variables for logs. A variable is shown only if its schema is registered in `publicVars`.
 * @param shape Schemas by variable name, in output order.
 * @param env Parsed values by variable name.
 * @returns Value per variable that is safe to log: native types for public ones.
 */
export function describeEnv(shape: Readonly<Record<string, z.ZodType>>, env: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const [name, schema] of Object.entries(shape)) {
    const value = env[name];

    if (value === undefined) {
      values[name] = '(unset)';
    } else if (publicVars.has(schema)) {
      values[name] = typeof value === 'string' ? stripUserinfo(value) : value;
    } else {
      values[name] = '***';
    }
  }

  return values;
}

/**
 * Builds the startup summary of the configuration without secrets.
 * @param env Parsed environment.
 * @returns Printable values and warnings.
 */
export function describeConfig(env: ParsedEnv): ConfigSummary {
  const warnings: string[] = [];

  if (env.REPEAT_EVERY_N_RUNS === 0 && env.SCENARIOS.includes(CHECK_NOTIFICATION)) {
    warnings.push('REPEAT_EVERY_N_RUNS is 0: the threshold rule is not checked');
  }

  return { values: describeEnv(ENV_SHAPE, env),
    warnings };
}
