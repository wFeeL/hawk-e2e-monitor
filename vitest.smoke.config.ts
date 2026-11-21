import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/smoke/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/support/global-setup.ts'],
    testTimeout: 30_000,
  },
});
