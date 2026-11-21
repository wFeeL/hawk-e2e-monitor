import process from 'node:process';
import { defineConfig } from 'vitest/config';

// Without this the suite would report every test as skipped and exit 0.
if (process.env.E2E_HAWK !== '1') {
  throw new Error('set E2E_HAWK=1 and the Hawk variables to run the e2e suite');
}

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    testTimeout: 600_000,
  },
});
