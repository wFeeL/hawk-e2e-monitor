import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { sendJson, sendText } from '../../src/http/respond.js';

const servers: Server[] = [];

/**
 * Starts a server whose only answer is made by `answer`.
 * @param answer Writes the response.
 * @returns Base URL.
 */
async function serve(answer: (res: Parameters<typeof sendJson>[0]) => void): Promise<string> {
  const server = createServer((_req, res) => {
    answer(res);
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  })));
});

describe('sendJson', () => {
  it('writes an uncached JSON body with the status and the extra headers', async () => {
    const url = await serve((res) => {
      sendJson(res, 429, { error: 'slow_down' }, Object.fromEntries([['retry-after', '7']]));
    });
    const response = await fetch(url);

    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.json()).toEqual({ error: 'slow_down' });
  });
});

describe('sendText', () => {
  it('writes the body with the given content type', async () => {
    const url = await serve((res) => {
      sendText(res, 200, 'a 1\n', 'text/plain; version=0.0.4; charset=utf-8');
    });
    const response = await fetch(url);

    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('a 1\n');
  });
});
