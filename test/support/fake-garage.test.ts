import { describe, expect, it } from 'vitest';
import { BUNDLE_PATH, startFakeGarage } from './fake-garage.js';

describe('fake garage', () => {
  it('serves an index page with a module script and the script, honouring Range with 206', async () => {
    const garage = await startFakeGarage();

    try {
      const index = await fetch(`${garage.origin}/`);

      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain(`src="${BUNDLE_PATH}"`);

      const bundle = await fetch(`${garage.origin}${BUNDLE_PATH}`, { headers: { range: 'bytes=0-9' } });

      expect(bundle.status).toBe(206);
      expect((await bundle.text())).toBe('const answ');
      expect(garage.requests.at(-1)).toEqual({ path: BUNDLE_PATH,
        range: 'bytes=0-9' });
    } finally {
      await garage.close();
    }
  });

  it('answers the whole script with 200 when it ignores Range', async () => {
    const garage = await startFakeGarage();

    try {
      garage.ignoreRange(true);

      const bundle = await fetch(`${garage.origin}${BUNDLE_PATH}`, { headers: { range: 'bytes=0-9' } });

      expect(bundle.status).toBe(200);
      expect((await bundle.text()).length).toBeGreaterThan(1000);
    } finally {
      await garage.close();
    }
  });

  it('serves the index page for an unknown path and takes answers per path', async () => {
    const garage = await startFakeGarage();

    try {
      expect(await (await fetch(`${garage.origin}/nothing.js`)).text()).toContain('<!doctype html>');

      garage.answer('/', { status: 503,
        body: 'down' });
      expect((await fetch(`${garage.origin}/`)).status).toBe(503);
    } finally {
      await garage.close();
    }
  });
});
