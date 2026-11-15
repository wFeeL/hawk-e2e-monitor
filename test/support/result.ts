import type { ConfigError, LoadConfigResult, LoadedConfig } from '../../src/config/load.js';

/**
 * Narrows a successful load result so tests need no conditional expects.
 * @param result Result of `loadConfig`.
 * @returns Parsed config and env.
 */
export function expectOk(result: LoadConfigResult): LoadedConfig {
  if (!result.ok) {
    throw new Error(`Expected a valid config, got errors: ${JSON.stringify(result.errors)}`);
  }

  return { config: result.config,
    env: result.env };
}

/**
 * Narrows a failed load result so tests need no conditional expects.
 * @param result Result of `loadConfig`.
 * @returns Config errors.
 */
export function expectErrors(result: LoadConfigResult): ConfigError[] {
  if (result.ok) {
    throw new Error('Expected config errors, got a valid config');
  }

  return result.errors;
}
