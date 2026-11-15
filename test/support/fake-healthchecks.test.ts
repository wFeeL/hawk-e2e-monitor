import { describe, expect, it } from 'vitest';
import { startFakeHealthchecks } from './fake-healthchecks.js';

describe('fake healthchecks', () => {
  it('counts pings on its path, answers with the set status and 404 elsewhere', async () => {
    const fake = await startFakeHealthchecks();

    try {
      expect((await fetch(fake.url)).status).toBe(200);
      expect(fake.pings).toBe(1);

      fake.setStatus(500);
      expect((await fetch(fake.url)).status).toBe(500);
      expect(fake.pings).toBe(2);

      expect((await fetch(new URL('/other', fake.url))).status).toBe(404);
      expect((await fetch(fake.url, { method: 'POST' })).status).toBe(404);
      expect(fake.pings).toBe(2);
    } finally {
      await fake.close();
    }
  });

  it('gives each fake its own path', async () => {
    const [first, second] = await Promise.all([startFakeHealthchecks(), startFakeHealthchecks()]);

    expect(first.key).not.toBe(second.key);
    await Promise.all([first.close(), second.close()]);
  });
});
