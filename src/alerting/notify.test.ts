import { afterEach, describe, expect, it } from 'vitest';
import type { CheckError } from '../errors/taxonomy.js';
import { startFakeNotify } from '../test-support/fake-notify.js';
import type { FakeNotify } from '../test-support/fake-notify.js';
import { systemClock } from '../time/clock.js';
import { sendNotify } from './notify.js';

const DEPS = { httpTimeoutMs: 3000,
  clock: systemClock };
const SIGNAL = new AbortController().signal;

const bots: FakeNotify[] = [];

afterEach(async () => {
  await Promise.all(bots.splice(0).map(async bot => bot.close()));
});

/**
 * Starts a fake bot that is closed after the test.
 * @param answer First answer.
 * @returns Running fake.
 */
async function startBot(answer: Parameters<typeof startFakeNotify>[0] = {}): Promise<FakeNotify> {
  const started = await startFakeNotify(answer);

  bots.push(started);

  return started;
}

/**
 * Takes the error a call rejects with.
 * @param call Call that is expected to fail.
 * @returns The error the call threw.
 */
async function rejection(call: Promise<void>): Promise<CheckError> {
  try {
    await call;
  } catch (error) {
    return error as CheckError;
  }

  throw new Error('Expected a rejection');
}

describe('sendNotify', () => {
  it('posts a form with the HTML flags and accepts 200 with OK!', async () => {
    const fake = await startBot();

    await sendNotify(fake.url, '<b>FAILED</b> x & y', DEPS, SIGNAL);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toEqual({ path: new URL(fake.url).pathname,
      contentType: 'application/x-www-form-urlencoded',
      form: Object.fromEntries([['message', '<b>FAILED</b> x & y'], ['parse_mode', 'HTML'], ['disable_web_page_preview', 'true']]) });
  });

  it('accepts a body that only contains OK!', async () => {
    await sendNotify((await startBot({ body: 'Message OK! sent' })).url, 'x', DEPS, SIGNAL);
  });

  it('200 with another body is alert_rejected', async () => {
    const error = await rejection(sendNotify((await startBot({ body: 'nope' })).url, 'x', DEPS, SIGNAL));

    expect(error.errorClass).toBe('alert_rejected');
    expect(error.culprit).toBe('config');
    expect(error.message).toBe('codex.bot did not accept the alert: 200 nope');
  });

  it('a 404 is alert_rejected and the body is cut to 200 characters', async () => {
    const error = await rejection(sendNotify((await startBot({ status: 404,
      body: 'z'.repeat(500) })).url, 'x', DEPS, SIGNAL));

    expect(error.errorClass).toBe('alert_rejected');
    expect(error.message).toBe(`codex.bot did not accept the alert: 404 ${'z'.repeat(200)}`);
  });

  it('a refused connection is a network error that names the host but not the token', async () => {
    const fake = await startBot();
    const { url, token } = fake;

    await fake.close();

    const error = await rejection(sendNotify(url, 'x', DEPS, SIGNAL));

    expect(error.errorClass).toBe('network_error');
    expect(error.culprit).toBe('network');
    expect(error.message).toContain('127.0.0.1');
    expect(JSON.stringify([error.message, error.facts])).not.toContain(token);
    expect(error.cause).toBeUndefined();
  });

  it('a bot that does not answer in time is a network error', async () => {
    const fake = await startBot({ delayMs: 30_000 });
    const error = await rejection(sendNotify(fake.url, 'x', { ...DEPS,
      httpTimeoutMs: 300 }, SIGNAL));

    expect(error.errorClass).toBe('network_error');
    expect(error.facts.code).toBe('TIMEOUT');
  });

  it('a signal that is aborted ends the call', async () => {
    const fake = await startBot({ delayMs: 30_000 });
    const controller = new AbortController();
    const pending = rejection(sendNotify(fake.url, 'x', DEPS, controller.signal));

    controller.abort();
    expect((await pending).errorClass).toBe('network_error');
  });
});
