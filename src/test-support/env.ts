/**
 * Builds a minimal valid environment for config tests.
 * @param overrides Variables that replace or remove (when undefined) the defaults.
 * @returns Environment accepted by `loadConfig`.
 */
export function validEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    INSTANCE_ID: 'test',
    HAWK_API_URL: 'http://localhost:4000/graphql',
    HAWK_INTEGRATION_TOKEN: 'test-token',
    HAWK_PROJECT_ID: 'test-project',
    HAWK_EMAIL: 'monitor@example.com',
    HAWK_PASSWORD: 'test-password',
    ...overrides,
  };
}
