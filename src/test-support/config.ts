import { loadConfig } from '../config/load.js';
import type { Config } from '../config/load.js';
import { validEnv } from './env.js';
import { expectOk } from './result.js';

/**
 * Builds a config for tests: random loopback port and short timeouts.
 * @param overrides Top-level fields that replace the defaults (nested objects are replaced whole).
 * @returns Complete configuration.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    instanceId: 'test',
    logLevel: 'error',
    internal: { host: '127.0.0.1',
      port: 0 },
    shutdownTimeoutMs: 1000,
    healthCheckTimeoutMs: 100,
    hawk: expectOk(loadConfig(validEnv())).config.hawk,
    ...overrides,
  };
}
