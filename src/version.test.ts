import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SERVICE_VERSION } from './version.js';

describe('SERVICE_VERSION', () => {
  it('matches package.json version', () => {
    const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

    expect(SERVICE_VERSION).toBe(pkg.version);
  });

  it('is a semver string', () => {
    expect(SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
