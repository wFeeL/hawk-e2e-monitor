import type { z } from 'zod';
import { ENV_SHAPE, publicVars } from './schema.js';
import type { ParsedEnv } from './schema.js';

/** Configuration summary safe to write to logs. */
export interface ConfigSummary {
  /** Printable value of every variable: public values, `***` for secrets, `(unset)` for missing ones. */
  values: Record<string, string>;
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
 * Converts a parsed value to text; plain strings, numbers and booleans are the expected cases.
 * @param value Parsed variable value.
 * @returns Text form of the value.
 */
function printable(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

/**
 * Prints variables for logs. A variable is shown only if its schema is registered in `publicVars`.
 * @param shape Schemas by variable name, in output order.
 * @param env Parsed values by variable name.
 * @returns Printable value per variable.
 */
export function describeEnv(shape: Readonly<Record<string, z.ZodType>>, env: Readonly<Record<string, unknown>>): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [name, schema] of Object.entries(shape)) {
    const value = env[name];

    if (value === undefined) {
      values[name] = '(unset)';
    } else if (publicVars.has(schema)) {
      values[name] = stripUserinfo(printable(value));
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
  const hostname = new URL(env.HAWK_API_URL).hostname;
  const production = hostname === 'hawk.so' || hostname.endsWith('.hawk.so');

  if (env.HAWK_COLLECTOR_URL === undefined && !production) {
    warnings.push('HAWK_COLLECTOR_URL is not set: events will go to the production collector derived from the integration token (<integrationId>.k1.hawk.so)');
  }

  return { values: describeEnv(ENV_SHAPE, env),
    warnings };
}
