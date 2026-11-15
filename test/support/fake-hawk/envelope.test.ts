import { afterEach, describe, expect, it } from 'vitest';
import { startFakeHawk } from './index.js';
import type { FakeHawk } from './index.js';
import { decodeTokenKey } from './token.js';

const hawks: FakeHawk[] = [];

/**
 * Posts a body to the envelope path of the fake collector.
 * @param hawk Fake Hawk.
 * @param body Request body.
 * @param query Query string of the address.
 * @param headers Request headers.
 * @returns HTTP status and message of the answer.
 */
async function post(hawk: FakeHawk, body: string, query: string, headers: Array<[string, string]> = []): Promise<[number, string]> {
  const response = await fetch(new URL(`/api/0/envelope/${query}`, hawk.collector.url), { method: 'POST',
    headers: new Headers(headers),
    body });
  const parsed = await response.json() as Record<'message', string>;

  return [response.status, parsed.message];
}

/**
 * Builds an envelope with one event.
 * @param sdk Name of the SDK.
 * @param extra Fields of the event.
 * @returns Envelope text.
 */
function envelope(sdk: string, extra: Record<string, unknown> = {}): string {
  return [JSON.stringify(Object.fromEntries([['sent_at', '2026-11-15T12:00:00Z']])),
    JSON.stringify({ type: 'event' }),
    JSON.stringify({ exception: { values: [{ type: 'Boom',
      value: 'it broke' }] },
    sdk: { name: sdk },
    ...extra }), ''].join('\n');
}

afterEach(async () => {
  await Promise.all(hawks.splice(0).map(async hawk => hawk.close()));
});

describe('fake collector envelope path', () => {
  it('stores the event under the project of the key, as the default worker takes it', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);

    const key = decodeTokenKey(hawk.token) ?? '';

    expect(await post(hawk, envelope('sentry.python', { level: 'warning',
      contexts: { e2e: { runId: 'r' } } }), `?sentry_key=${key}`)).toEqual([200, 'OK']);

    const [event] = hawk.store.all(hawk.projectId);

    expect(event).toMatchObject({ catcherType: 'errors/default' });
    expect(event?.payload).toMatchObject({ title: 'Boom: it broke',
      type: 'warning',
      context: { e2e: { runId: 'r' } } });
  });

  it('sends an event of a JavaScript SDK to the JavaScript worker', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);
    await post(hawk, envelope('sentry.javascript.browser'), `?sentry_key=${decodeTokenKey(hawk.token) ?? ''}`);

    expect(hawk.store.all(hawk.projectId)[0]?.catcherType).toBe('errors/javascript');
  });

  it('files the event under the project of a token created later', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);

    const made = hawk.projects.create('fake-workspace', 'x');

    await post(hawk, envelope('sentry.python'), `?sentry_key=${made?.tokenKey ?? ''}`);

    expect(hawk.store.all(made?.id ?? '')).toHaveLength(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('answers 200 and stores nothing when the accepted event is dropped by the knob', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);
    hawk.collector.knobs.dropEvents = true;

    expect((await post(hawk, envelope('sentry.python'), `?sentry_key=${decodeTokenKey(hawk.token) ?? ''}`))[0]).toBe(200);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it.each([
    ['no key', '', 'X-Sentry-Auth header is missing'],
    ['an unknown key', '?sentry_key=abc', 'Integration token invalid: abc'],
  ])('refuses %s', async (_name, query, message) => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);

    expect(await post(hawk, envelope('sentry.python'), query)).toEqual([400, message]);
  });

  it('refuses a body that is not an envelope', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);

    expect(await post(hawk, 'not json\n', `?sentry_key=${decodeTokenKey(hawk.token) ?? ''}`)).toEqual([400, 'Failed to process Sentry envelope']);
  });

  it('reads the key from the X-Sentry-Auth header too', async () => {
    const hawk = await startFakeHawk();

    hawks.push(hawk);

    const key = decodeTokenKey(hawk.token) ?? '';

    expect((await post(hawk, envelope('sentry.python'), '', [['x-sentry-auth', `Sentry sentry_version=7, sentry_key=${key}`]]))[0]).toBe(200);
  });
});
