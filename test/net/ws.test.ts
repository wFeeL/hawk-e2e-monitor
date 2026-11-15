import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeCollector } from '../support/fake-hawk/collector.js';
import type { FakeCollector } from '../support/fake-hawk/collector.js';
import { createFakeStore } from '../support/fake-hawk/store.js';
import { decodeTokenKey, encodeToken } from '../support/fake-hawk/token.js';
import { sendOverWebSocket } from '../../src/net/ws.js';
import type { WsSendOptions } from '../../src/net/ws.js';

const TOKEN = encodeToken('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
const MESSAGE = JSON.stringify({ token: TOKEN,
  catcherType: 'errors/javascript',
  payload: { title: 'ws test' } });

let collector: FakeCollector;

/**
 * Builds send options with a fresh signal.
 * @param timeoutMs Deadline of the exchange.
 * @param signal Abort signal, never aborted by default.
 * @returns Options for `sendOverWebSocket`.
 */
function options(timeoutMs = 1000, signal: AbortSignal = new AbortController().signal): WsSendOptions {
  return { timeoutMs,
    signal };
}

beforeEach(async () => {
  collector = await startFakeCollector({ store: createFakeStore(),
    projectId: 'a'.repeat(24),
    validTokenKey: decodeTokenKey(TOKEN) ?? '' });
});

afterEach(async () => {
  await collector.close();
});

describe('sendOverWebSocket', () => {
  it('response to a message', async () => {
    const outcome = await sendOverWebSocket(collector.wsUrl, MESSAGE, options());

    expect(outcome.kind).toBe('response');
    expect(outcome.kind === 'response' ? JSON.parse(outcome.text) : undefined).toEqual({ code: 200,
      error: false,
      message: 'OK' });
    expect(collector.wsMessages).toBe(1);
  });

  it('reject_upgrade is handshake_failed', async () => {
    collector.knobs.ws = 'reject_upgrade';

    const outcome = await sendOverWebSocket(collector.wsUrl, MESSAGE, options());

    expect(outcome).toEqual({ kind: 'handshake_failed',
      detail: 'connection closed before open (code 1006)' });
    expect(collector.wsMessages).toBe(0);
  });

  it('closed port is handshake_failed', async () => {
    const { wsUrl } = collector;

    await collector.close();

    const outcome = await sendOverWebSocket(wsUrl, MESSAGE, options());

    expect(outcome.kind).toBe('handshake_failed');
  });

  it('close_after_message is closed after send', async () => {
    collector.knobs.ws = 'close_after_message';

    const outcome = await sendOverWebSocket(collector.wsUrl, MESSAGE, options());

    expect(outcome).toEqual({ kind: 'closed',
      sent: true,
      code: 1005 });
    expect(collector.wsMessages).toBe(1);
  });

  it('silent is timeout after send', async () => {
    collector.knobs.ws = 'silent';

    const outcome = await sendOverWebSocket(collector.wsUrl, MESSAGE, options(100));

    expect(outcome).toEqual({ kind: 'timeout',
      sent: true });
    expect(collector.wsMessages).toBe(1);
  });

  it('abort after send is timeout with sent true', async () => {
    collector.knobs.ws = 'silent';

    const controller = new AbortController();
    const running = sendOverWebSocket(collector.wsUrl, MESSAGE, options(5000, controller.signal));

    await vi.waitFor(() => {
      expect(collector.wsMessages).toBe(1);
    }, { timeout: 1000 });
    controller.abort();

    expect(await running).toEqual({ kind: 'timeout',
      sent: true });
  });

  it('an already aborted signal gives timeout without opening a socket', async () => {
    const controller = new AbortController();

    controller.abort();

    expect(await sendOverWebSocket(collector.wsUrl, MESSAGE, options(1000, controller.signal))).toEqual({ kind: 'timeout',
      sent: false });
    expect(collector.wsClients()).toBe(0);
    expect(collector.wsMessages).toBe(0);
  });

  it('a bad URL throws', async () => {
    await expect(sendOverWebSocket('not a url', MESSAGE, options())).rejects.toThrow();
  });

  it('socket is closed afterwards', async () => {
    await sendOverWebSocket(collector.wsUrl, MESSAGE, options());

    await vi.waitFor(() => {
      expect(collector.wsClients()).toBe(0);
    }, { timeout: 200 });
  });
});
