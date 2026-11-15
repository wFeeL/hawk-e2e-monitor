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
  const { config } = expectOk(loadConfig(validEnv({
    HTTP_TIMEOUT_MS: '100',
    COLLECTOR_AVAILABILITY_TIMEOUT_MS: '300',
    API_AVAILABILITY_TIMEOUT_MS: '300',
    COLLECTOR_ACCEPT_TIMEOUT_MS: '300',
    EVENT_VISIBLE_TIMEOUT_MS: '300',
    EVENT_REPEATED_TIMEOUT_MS: '300',
    CLEANUP_TIMEOUT_MS: '600',
    LATE_DUPLICATE_WAIT_MS: '10',
    RUN_TIMEOUT_MS: '3000',
    NOTIFICATION_TIMEOUT_MS: '500',
    NOTIFICATION_PAIR_WAIT_MS: '100',
    NOTIFICATION_SETUP_TIMEOUT_MS: '600',
    RULE_CACHE_WARMUP_MS: '50',
    RETRY_DELAYS_MS: '5,10',
  })));

  return {
    ...config,
    logLevel: 'error',
    internal: { host: '127.0.0.1',
      port: 0 },
    shutdownTimeoutMs: 1000,
    healthCheckTimeoutMs: 100,
    notifications: { ...config.notifications,
      receiverPort: 0 },
    ...overrides,
  };
}
