import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/smoke/**', 'node_modules/**'],
    environment: 'node',
    globalSetup: ['test/support/global-setup.ts'],
  },
});
