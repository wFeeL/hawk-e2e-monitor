import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { checkGarage } from '../../../src/scenarios/endpoints-probe/garage.js';
import type { GarageDeps } from '../../../src/scenarios/endpoints-probe/garage.js';
import { systemClock } from '../../../src/time/clock.js';
import { BUNDLE_PATH, startFakeGarage } from '../../support/fake-garage.js';
import type { FakeGarage } from '../../support/fake-garage.js';

const DEPS: GarageDeps = { httpTimeoutMs: 1000,
  clock: systemClock,
  retry: { attempts: 2,
    delaysMs: [5] } };
const INDEX_WITH_SCRIPT = (src: string, attributes = 'type="module"'): string => `<!doctype html><html><head><script ${attributes} src="${src}"></script></head></html>`;

let garage: FakeGarage;

beforeEach(async () => {
  garage = await startFakeGarage();
});

afterEach(async () => {
  await garage.close();
});

/**
 * Runs the check and returns what it threw.
 * @returns The error of the check.
 */
async function failure(): Promise<CheckError> {
  try {
    await checkGarage(garage.origin, DEPS, new AbortController().signal);
  } catch (error) {
    if (error instanceof CheckError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected the check to fail');
}

describe('checkGarage', () => {
  it('passes on a healthy Garage and reports the bundle and the times', async () => {
    const result = await checkGarage(garage.origin, DEPS, new AbortController().signal);

    expect(result.bundle).toBe(BUNDLE_PATH);
    expect(result.indexMs).toBeGreaterThanOrEqual(0);
    expect(result.bundleMs).toBeGreaterThanOrEqual(0);
    expect(garage.requests).toEqual([{ path: '/',
      range: '' }, { path: BUNDLE_PATH,
      range: 'bytes=0-1023' }]);
  });

  it('accepts a 206 answer and a 200 answer to the range request, reading only the start', async () => {
    garage.ignoreRange(true);
    await expect(checkGarage(garage.origin, DEPS, new AbortController().signal)).resolves.toMatchObject({ bundle: BUNDLE_PATH });
  });

  it('finds the module script whatever the order of the attributes and the quotes', async () => {
    for (const html of [
      INDEX_WITH_SCRIPT(BUNDLE_PATH, 'crossorigin type=module'),
      `<script src='${BUNDLE_PATH}' type='module'></script>`,
      `<!-- x --><script SRC="${BUNDLE_PATH}" TYPE="Module" defer></script>`,
      `<script type="text/javascript" src="/other.js"></script><script defer type="module" src="${BUNDLE_PATH}"></script>`,
    ]) {
      garage.answer('/', { contentType: 'text/html',
        body: html });
      await expect(checkGarage(garage.origin, DEPS, new AbortController().signal)).resolves.toMatchObject({ bundle: BUNDLE_PATH });
    }
  });

  it('takes the script of the same origin and skips one of another origin', async () => {
    garage.answer('/', { contentType: 'text/html',
      body: `<script type="module" src="https://cdn.example.test/x.js"></script><script type="module" src="${BUNDLE_PATH}"></script>` });
    await expect(checkGarage(garage.origin, DEPS, new AbortController().signal)).resolves.toMatchObject({ bundle: BUNDLE_PATH });
  });

  it('fails when the index page has no module script, or only one of another origin', async () => {
    for (const html of ['<!doctype html><html></html>',
      '<script src="/a.js"></script>',
      '<script type="module">inline()</script>',
      '<script type="module" src="https://cdn.example.test/x.js"></script>']) {
      garage.answer('/', { contentType: 'text/html',
        body: html });

      const error = await failure();

      expect(error.errorClass).toBe('garage_unavailable');
      expect(error.culprit).toBe('hawk');
      expect(error.message).toBe(`Garage at ${garage.origin} did not serve the index page: index.html has no module script`);
    }
  });

  it('fails when the index page is not HTML or not 200', async () => {
    garage.answer('/', { contentType: 'application/json',
      body: '{}' });
    expect((await failure()).message).toContain('did not serve the index page: content-type is application/json');

    garage.answer('/', { status: 404,
      contentType: 'text/html',
      body: 'no' });
    expect((await failure()).message).toBe(`Garage at ${garage.origin} did not serve the index page: HTTP 404`);
  });

  it('fails when the bundle is HTML, as push-state serves for a missing file', async () => {
    garage.answer(BUNDLE_PATH, { contentType: 'text/html',
      body: '<!doctype html><html></html>' });

    const error = await failure();

    expect(error.errorClass).toBe('garage_unavailable');
    expect(error.message).toContain('did not serve the script bundle');
  });

  it('fails when the bundle has a JavaScript type but a body that starts with a tag', async () => {
    garage.answer(BUNDLE_PATH, { contentType: 'text/javascript',
      body: '  \n<!doctype html>' });
    expect((await failure()).message).toContain('did not serve the script bundle: the body starts with "<"');
  });

  it('fails on an empty bundle and on a bad status', async () => {
    garage.answer(BUNDLE_PATH, { contentType: 'text/javascript',
      body: '' });
    expect((await failure()).message).toContain('the body is empty');

    garage.answer(BUNDLE_PATH, { status: 500,
      contentType: 'text/javascript',
      body: 'x' });
    expect((await failure()).message).toContain('did not serve the script bundle: HTTP 500');
  });

  it('accepts application/javascript too', async () => {
    garage.answer(BUNDLE_PATH, { contentType: 'application/javascript',
      body: 'export {};' });
    await expect(checkGarage(garage.origin, DEPS, new AbortController().signal)).resolves.toBeDefined();
  });

  it('retries a 5xx of the index page and passes when it recovers', async () => {
    garage.answer('/', { status: 503,
      contentType: 'text/html',
      body: 'busy' });

    const pending = checkGarage(garage.origin, { ...DEPS,
      retry: { attempts: 3,
        delaysMs: [200, 200] } }, new AbortController().signal);

    await vi.waitFor(() => {
      expect(garage.requests).toHaveLength(1);
    }, { interval: 1 });
    garage.answer('/', { contentType: 'text/html',
      body: INDEX_WITH_SCRIPT(BUNDLE_PATH) });

    expect((await pending).bundle).toBe(BUNDLE_PATH);
    expect(garage.requests.filter(request => request.path === '/')).toHaveLength(2);
  });

  it('blames Garage for a closed port and keeps the address in the text', async () => {
    const origin = garage.origin;

    await garage.close();

    try {
      await checkGarage(origin, DEPS, new AbortController().signal);
      throw new Error('Expected the check to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CheckError);
      expect((error as CheckError).errorClass).toBe('garage_unavailable');
      expect((error as CheckError).message).toContain(`Garage at ${origin} did not serve the index page: connection refused (ECONNREFUSED)`);
    }

    garage = await startFakeGarage();
  });

  it('is cancelled by the signal', async () => {
    const controller = new AbortController();

    controller.abort();
    await expect(checkGarage(garage.origin, DEPS, controller.signal)).rejects.toBeInstanceOf(CheckError);
  });
});
