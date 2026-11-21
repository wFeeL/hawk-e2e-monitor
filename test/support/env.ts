import { Buffer } from 'node:buffer';

/** Integration id inside `TEST_INTEGRATION_TOKEN`. */
export const TEST_INTEGRATION_ID = '00000000-0000-4000-8000-000000000001';

/** Secret inside `TEST_INTEGRATION_TOKEN`; it differs from the id so that a test notices a mix-up of the two. */
export const TEST_INTEGRATION_SECRET = '11111111-2222-4333-8444-555555555555';

/** Valid integration token for config tests: base64 of a JSON with `integrationId` and `secret`. */
export const TEST_INTEGRATION_TOKEN = Buffer.from(JSON.stringify({ integrationId: TEST_INTEGRATION_ID,
  secret: TEST_INTEGRATION_SECRET })).toString('base64');

/** Valid 24-character hex project id for config tests. */
export const TEST_PROJECT_ID = '0123456789abcdef01234567';

/** Valid 32-character receiver secret for tests. */
export const TEST_RECEIVER_SECRET = 'test-receiver-secret-0123456789a';

/**
 * Builds a minimal valid environment for config tests.
 * @param overrides Variables that replace or remove (when undefined) the defaults.
 * @returns Environment accepted by `loadConfig`.
 */
export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    INSTANCE_ID: 'test',
    HAWK_API_URL: 'http://localhost:4000/graphql',
    HAWK_COLLECTOR_URL: 'http://localhost:3000/',
    HAWK_INTEGRATION_TOKEN: TEST_INTEGRATION_TOKEN,
    HAWK_PROJECT_ID: TEST_PROJECT_ID,
    HAWK_EMAIL: 'monitor@example.com',
    HAWK_PASSWORD: 'test-password',
    RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    // The default list holds scenarios that need a receiver address, so tests name one scenario unless they say otherwise.
    SCENARIOS: 'send-and-receive-event',
    ...overrides,
  };
}
