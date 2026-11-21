import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/load.js';
import { createScenarioRedactor, scenarioSecrets } from '../../src/scenarios/shared/deps.js';
import { TEST_INTEGRATION_ID, TEST_INTEGRATION_SECRET, validEnv } from '../support/env.js';
import { expectOk } from '../support/result.js';

/**
 * Loads the configuration of the minimal valid environment.
 * @returns Validated configuration.
 */
function config(): Config {
  return expectOk(loadConfig(validEnv())).config;
}

describe('secrets of the token', () => {
  it('lists the secret itself, not only the collector key built from it', () => {
    expect(TEST_INTEGRATION_SECRET).not.toBe(TEST_INTEGRATION_ID);
    expect(scenarioSecrets(config())).toContain(TEST_INTEGRATION_SECRET);
  });

  it('the scenario redactor masks the secret with its dashes', () => {
    expect(createScenarioRedactor(config())(`token says ${TEST_INTEGRATION_SECRET}!`)).toBe('token says ***!');
  });
});
