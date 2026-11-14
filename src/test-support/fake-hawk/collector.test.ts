import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startFakeCollector } from './collector.js';
import type { FakeCollector } from './collector.js';
import { createFakeStore } from './store.js';
import type { FakeStore } from './store.js';
import { decodeTokenKey, encodeToken } from './token.js';

const PROJECT = 'c'.repeat(24);
const TOKEN = encodeToken('11111111-2222-3333-4444-555555555555', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
const TOKEN_KEY = '11111111222233334444555555555555aaaaaaaabbbbccccddddeeeeeeeeeeee';
const JSON_TYPE = 'text/json; charset=utf8';
const PLAIN_TYPE = 'text/plain; charset=utf-8';

/** Fake collector with the store behind it. */
interface Harness {
  /** Running collector. */
  collector: FakeCollector;
  /** Store the collector writes to. */
  store: FakeStore;
}

const collectors: FakeCollector[] = [];
const sockets: WebSocket[] = [];

/**
 * Starts a collector over a fresh store; closed in afterEach.
 * @param blocked Optional block switch.
 * @returns Collector and store.
 */
async function start(blocked?: () => boolean): Promise<Harness> {
  const store = createFakeStore();
  const collector = await startFakeCollector({ store,
    projectId: PROJECT,
    validTokenKey: TOKEN_KEY,
    ...blocked ? { blocked } : {} });

  collectors.push(collector);

  return { collector,
    store };
}

/**
 * Builds a valid collector message.
 * @param title Event title.
 * @returns Message object.
 */
function validMessage(title = 'hello'): Record<string, unknown> {
  return { token: TOKEN,
    catcherType: 'errors/nodejs',
    payload: { title,
      context: { runId: 'r1' } } };
}

/** Answer as a test sees it. */
interface Reply {
  /** HTTP status. */
  status: number;
  /** Content-Type header. */
  type: string | null;
  /** Body text. */
  text: string;
}

/**
 * Sends a raw POST body to the collector.
 * @param collector Target collector.
 * @param body Raw body.
 * @returns Status, content type and text.
 */
async function post(collector: FakeCollector, body: string): Promise<Reply> {
  const response = await fetch(collector.url, { method: 'POST',
    body });

  return { status: response.status,
    type: response.headers.get('content-type'),
    text: await response.text() };
}

/**
 * Builds the expected JSON answer text.
 * @param code Status and body code.
 * @param message Body message.
 * @returns JSON text with keys in Hawk order.
 */
function jsonReply(code: number, message: string): string {
  return JSON.stringify({ code,
    error: code !== 200,
    message });
}

/**
 * Opens a ws client and waits for it to open.
 * @param collector Target collector.
 * @returns Open socket.
 */
async function connect(collector: FakeCollector): Promise<WebSocket> {
  const socket = new WebSocket(collector.wsUrl);

  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return socket;
}

/** A received ws message. */
interface Received {
  /** UTF-8 text. */
  text: string;
  /** Whether the frame was binary. */
  binary: boolean;
}

/**
 * Waits for the next message of a socket.
 * @param socket Client socket.
 * @returns Text and frame type.
 */
function nextMessage(socket: WebSocket): Promise<Received> {
  return new Promise((resolve) => {
    socket.once('message', (data: Buffer, binary: boolean) => {
      resolve({ text: data.toString(),
        binary });
    });
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }

  await Promise.all(collectors.splice(0).map(async collector => collector.close()));
});

describe('token helpers', () => {
  it('decodes the key without dashes and rejects garbage', () => {
    expect(decodeTokenKey(TOKEN)).toBe(TOKEN_KEY);
    expect(decodeTokenKey('!!!')).toBeUndefined();
    expect(decodeTokenKey(Buffer.from('nope').toString('base64'))).toBeUndefined();
    expect(decodeTokenKey(encodeToken('', 'x'))).toBeUndefined();
  });
});

describe('fake collector POST /', () => {
  it.each([
    ['Invalid JSON format', 'not json'],
    ['Invalid JSON format', '[1]'],
    ['Invalid JSON format', JSON.stringify({ ...validMessage(),
      token: 5 })],
    ['Payload is empty', JSON.stringify({ token: TOKEN,
      catcherType: 'errors/nodejs' })],
    ['Token is empty', JSON.stringify({ catcherType: 'errors/nodejs',
      payload: {} })],
    ['CatcherType is empty', JSON.stringify({ token: TOKEN,
      payload: {} })],
    ['Token decoding error', JSON.stringify({ ...validMessage(),
      token: '!!!' })],
    ['Invalid payload JSON format', JSON.stringify({ ...validMessage(),
      payload: 'text' })],
  ])('400 %s', async (message, body) => {
    const { collector, store } = await start();
    const reply = await post(collector, body);

    expect(reply).toEqual({ status: 400,
      type: JSON_TYPE,
      text: jsonReply(400, message) });
    expect(store.all(PROJECT)).toEqual([]);
  });

  it('400 Integration token invalid carries the decoded key', async () => {
    const { collector } = await start();
    const wrong = encodeToken('aaaa-bbbb', 'cccc-dddd');
    const reply = await post(collector, JSON.stringify({ ...validMessage(),
      token: wrong }));

    expect(reply).toEqual({ status: 400,
      type: JSON_TYPE,
      text: jsonReply(400, 'Integration token invalid: aaaabbbbccccdddd') });
  });

  it('402 when the project is blocked', async () => {
    const { collector, store } = await start(() => true);
    const reply = await post(collector, JSON.stringify(validMessage()));

    expect(reply).toEqual({ status: 402,
      type: JSON_TYPE,
      text: jsonReply(402, 'Project has exceeded the events limit') });
    expect(store.all(PROJECT)).toEqual([]);
  });

  it('200 OK stores the event', async () => {
    const { collector, store } = await start();
    const reply = await post(collector, JSON.stringify(validMessage()));

    expect(reply).toEqual({ status: 200,
      type: JSON_TYPE,
      text: jsonReply(200, 'OK') });
    expect(store.all(PROJECT)).toHaveLength(1);
    expect(store.all(PROJECT)[0]?.catcherType).toBe('errors/nodejs');
  });

  it('413 plain text for a body over 1 000 000 bytes', async () => {
    const { collector, store } = await start();
    const reply = await post(collector, JSON.stringify({ ...validMessage(),
      padding: 'x'.repeat(1_000_001) }));

    expect(reply).toEqual({ status: 413,
      type: PLAIN_TYPE,
      text: 'Request is too large' });
    expect(store.all(PROJECT)).toEqual([]);
  });

  it('404 plain text for other paths', async () => {
    const { collector } = await start();
    const response = await fetch(new URL('/nope', collector.url));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PLAIN_TYPE);
    expect(await response.text()).toBe('Not found');
  });

  it('posts counter counts every POST', async () => {
    const { collector } = await start();

    await post(collector, 'not json');
    await post(collector, JSON.stringify(validMessage()));
    await post(collector, JSON.stringify({ ...validMessage(),
      padding: 'x'.repeat(1_000_001) }));

    expect(collector.posts).toBe(3);
  });
});

describe('fake collector /health', () => {
  it('200 with both flags true by default', async () => {
    const { collector } = await start();
    const response = await fetch(new URL('/health', collector.url));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(JSON_TYPE);
    expect(await response.text()).toBe('{"redis_status":true,"mongo_db_status":true}');
  });

  it('500 when a flag is false', async () => {
    const { collector } = await start();

    collector.knobs.health = { status: 500,
      redis: true,
      mongo: false };

    const response = await fetch(new URL('/health', collector.url));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"redis_status":true,"mongo_db_status":false}');
  });

  it('explicit status wins over the flags', async () => {
    const { collector } = await start();

    collector.knobs.health = { status: 200,
      redis: false,
      mongo: true };

    expect((await fetch(new URL('/health', collector.url))).status).toBe(200);
  });

  it('plain text knob', async () => {
    const { collector } = await start();

    collector.knobs.health = { status: 503,
      text: 'down' };

    const response = await fetch(new URL('/health', collector.url));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('down');
  });
});

describe('fake collector knobs', () => {
  it('accepted event appears in store only after processingDelayMs', async () => {
    const { collector, store } = await start();

    collector.knobs.processingDelayMs = 100;

    const reply = await post(collector, JSON.stringify(validMessage()));

    expect(reply.status).toBe(200);
    expect(store.all(PROJECT)).toEqual([]);
    await vi.waitFor(() => {
      expect(store.all(PROJECT)).toHaveLength(1);
    }, { timeout: 1000 });
  });

  it('reply override is not accepted and can depend on the submission number', async () => {
    const { collector, store } = await start();

    collector.knobs.reply = submission => submission === 2
      ? { status: 402,
          body: jsonReply(402, 'Rate limit exceeded') }
      : undefined;

    const first = await post(collector, JSON.stringify(validMessage()));
    const second = await post(collector, JSON.stringify(validMessage()));

    expect(first.status).toBe(200);
    expect(second).toEqual({ status: 402,
      type: JSON_TYPE,
      text: jsonReply(402, 'Rate limit exceeded') });
    expect(store.all(PROJECT)[0]?.totalCount).toBe(1);
  });

  it('reply override keeps a custom content type', async () => {
    const { collector } = await start();

    collector.knobs.reply = { status: 429,
      body: 'Too Many Requests',
      contentType: PLAIN_TYPE };

    expect(await post(collector, '{}')).toEqual({ status: 429,
      type: PLAIN_TYPE,
      text: 'Too Many Requests' });
  });

  it('replyAfterAccept answers differently but stores the event', async () => {
    const { collector, store } = await start();

    collector.knobs.replyAfterAccept = { status: 503,
      body: 'Service Unavailable',
      contentType: PLAIN_TYPE };

    const reply = await post(collector, JSON.stringify(validMessage()));

    expect(reply.status).toBe(503);
    expect(store.all(PROJECT)).toHaveLength(1);
  });

  it('replyDelayMs delays the answer after accept', async () => {
    const { collector, store } = await start();

    collector.knobs.replyDelayMs = 150;

    const started = performance.now();
    const pending = post(collector, JSON.stringify(validMessage()));

    await vi.waitFor(() => {
      expect(store.all(PROJECT)).toHaveLength(1);
    });
    expect(performance.now() - started).toBeLessThan(150);
    expect((await pending).status).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it('dropEvents accepts without storing, also per submission', async () => {
    const { collector, store } = await start();

    collector.knobs.dropEvents = submission => submission > 1;
    await post(collector, JSON.stringify(validMessage()));

    const second = await post(collector, JSON.stringify(validMessage()));

    expect(second.status).toBe(200);
    expect(store.all(PROJECT)[0]?.totalCount).toBe(1);

    collector.knobs.dropEvents = true;
    await post(collector, JSON.stringify(validMessage('other')));
    expect(store.all(PROJECT)).toHaveLength(1);
  });

  it('duplicateOnAccept processes twice', async () => {
    const { collector, store } = await start();

    collector.knobs.duplicateOnAccept = true;
    await post(collector, JSON.stringify(validMessage()));

    expect(store.all(PROJECT)[0]?.totalCount).toBe(2);
  });

  it('mutatePayload changes the stored payload', async () => {
    const { collector, store } = await start();

    collector.knobs.mutatePayload = payload => ({ ...payload,
      title: 'mutated' });
    await post(collector, JSON.stringify(validMessage()));

    expect(store.all(PROJECT)[0]?.payload.title).toBe('mutated');
  });
});

describe('fake collector WebSocket', () => {
  it('ws replies to every message and keeps the socket open', async () => {
    const { collector, store } = await start();
    const socket = await connect(collector);
    const texts: string[] = [];

    for (const message of [validMessage('one'), { ...validMessage('two'),
      token: encodeToken('aa', 'bb') }, validMessage('three')]) {
      const answer = nextMessage(socket);

      socket.send(JSON.stringify(message));
      texts.push((await answer).text);
    }

    expect(texts).toEqual([
      jsonReply(200, 'OK'),
      jsonReply(400, 'Integration token invalid: aabb'),
      jsonReply(200, 'OK'),
    ]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(collector.wsMessages).toBe(3);
    expect(collector.wsClients()).toBe(1);
    expect(store.all(PROJECT)).toHaveLength(2);
  });

  it('answers with the same frame type', async () => {
    const { collector } = await start();
    const socket = await connect(collector);
    const answer = nextMessage(socket);

    socket.send(JSON.stringify(validMessage()), { binary: false });

    expect((await answer).binary).toBe(false);
  });

  it('reply override sends only its body', async () => {
    const { collector } = await start();
    const socket = await connect(collector);
    const answer = nextMessage(socket);

    collector.knobs.reply = { status: 402,
      body: jsonReply(402, 'Rate limit exceeded') };
    socket.send(JSON.stringify(validMessage()));

    expect((await answer).text).toBe(jsonReply(402, 'Rate limit exceeded'));
  });

  it('ws reject_upgrade fails the handshake', async () => {
    const { collector } = await start();

    collector.knobs.ws = 'reject_upgrade';

    const socket = new WebSocket(collector.wsUrl);
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
      });
      socket.once('error', () => {
        resolve(undefined);
      });
    });

    expect(status).toBe(403);
    expect(collector.wsClients()).toBe(0);
  });

  it('blacklisted answers every path with 429 before routing, and counts no POST', async () => {
    const { collector, store } = await start();

    collector.knobs.blacklisted = true;

    for (const path of ['', 'health', 'other']) {
      const response = await fetch(new URL(path, collector.url), { method: path === '' ? 'POST' : 'GET',
        ...path === '' ? { body: JSON.stringify(validMessage()) } : {} });

      expect(response.status).toBe(429);
      expect(response.headers.get('content-type')).toBe(PLAIN_TYPE);
      expect(await response.text()).toBe('Too Many Requests');
    }

    expect(collector.posts).toBe(0);
    expect(store.all(PROJECT)).toHaveLength(0);
  });

  it('blacklisted refuses the WebSocket upgrade with 429', async () => {
    const { collector } = await start();

    collector.knobs.blacklisted = true;

    const socket = new WebSocket(collector.wsUrl);
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode);
      });
      socket.once('error', () => {
        resolve(undefined);
      });
    });

    expect(status).toBe(429);
  });

  it('close_after_message accepts the event and closes without a reply', async () => {
    const { collector, store } = await start();
    const socket = await connect(collector);
    const messages: string[] = [];

    socket.on('message', (data: Buffer) => messages.push(data.toString()));
    collector.knobs.ws = 'close_after_message';

    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });

    socket.send(JSON.stringify(validMessage()));
    await closed;

    expect(messages).toEqual([]);
    expect(store.all(PROJECT)).toHaveLength(1);
  });

  it('silent accepts the event and never answers', async () => {
    const { collector, store } = await start();
    const socket = await connect(collector);
    const messages: string[] = [];

    socket.on('message', (data: Buffer) => messages.push(data.toString()));
    collector.knobs.ws = 'silent';
    socket.send(JSON.stringify(validMessage()));

    await vi.waitFor(() => {
      expect(store.all(PROJECT)).toHaveLength(1);
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(messages).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it('close terminates open sockets and pending delays', async () => {
    const { collector } = await start();
    const socket = await connect(collector);
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        resolve();
      });
    });

    collector.knobs.ws = 'silent';
    await collector.close();
    await closed;

    expect(collector.wsClients()).toBe(0);
  });
});
