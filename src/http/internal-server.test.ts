import type { Server } from 'node:http';
import type { Buffer } from 'node:buffer';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryLogger } from '../test-support/logger.js';
import { createInternalServer } from './internal-server.js';
import type { InternalServerOptions } from './internal-server.js';

const HUNG_TIMEOUT_MS = 50;
const SLOW_CHECK_MS = 60;
const PARALLEL_BUDGET_MS = 150;
const HANG_BUDGET_MS = 1000;

const servers: Server[] = [];

/** Running server and the helper to call it. */
interface Running {
  /** Port the server listens on. */
  port: number;
  /** Fetches a path from the server. */
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Starts an internal server on a random loopback port.
 * @param overrides Options replacing the empty defaults.
 * @returns Helper bound to the server address.
 */
async function start(overrides: Partial<InternalServerOptions> = {}): Promise<Running> {
  const server = createInternalServer({
    logger: memoryLogger(),
    liveness: [],
    readiness: [],
    checkTimeoutMs: 100,
    ...overrides,
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return { port,
    call: async (path, init) => fetch(`http://127.0.0.1:${String(port)}${path}`, init) };
}

/**
 * Resolves after a delay.
 * @param ms Delay in milliseconds.
 * @returns Promise settled by a real timer.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  })));
});

describe('internal server', () => {
  it('healthz ok with no checks', async () => {
    const { call } = await start();
    const res = await call('/healthz');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('healthz fails with failing check', async () => {
    const { call } = await start({ liveness: [{ name: 'scheduler',
      run: () => Promise.resolve(false) }] });
    const res = await call('/healthz');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'fail',
      failed: ['scheduler'] });
  });

  it('throwing check is a failure', async () => {
    const { call } = await start({
      readiness: [{
        name: 'db',
        run: () => {
          throw new Error('boom');
        },
      }],
    });
    const res = await call('/readyz');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'fail',
      failed: ['db'] });
  });

  it('hanging check times out', async () => {
    let seen: AbortSignal | undefined;
    const { call } = await start({
      checkTimeoutMs: HUNG_TIMEOUT_MS,
      readiness: [{
        name: 'hung',
        run: (signal) => {
          seen = signal;

          return new Promise<boolean>(() => undefined);
        },
      }],
    });
    const started = performance.now();
    const res = await call('/readyz');

    expect(res.status).toBe(503);
    expect(performance.now() - started).toBeLessThan(HANG_BUDGET_MS);
    expect(seen?.aborted).toBe(true);
  });

  it('checks run in parallel', async () => {
    const slow = (name: string): InternalServerOptions['liveness'][number] => ({
      name,
      run: async () => {
        await sleep(SLOW_CHECK_MS);

        return true;
      },
    });
    const { call } = await start({
      checkTimeoutMs: 200,
      liveness: [slow('a'), slow('b'), slow('c')],
    });
    const started = performance.now();
    const res = await call('/healthz');

    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(PARALLEL_BUDGET_MS);
  });

  it('unknown path is 404', async () => {
    const { call } = await start();
    const res = await call('/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('wrong method is 405', async () => {
    const { call } = await start();
    const res = await call('/healthz', { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('custom route is served', async () => {
    const { call } = await start({
      routes: new Map([['GET /x', (_req, res) => {
        res.writeHead(200).end('ok');
      }]]),
    });
    const res = await call('/x');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('handler failure is 500 and logged', async () => {
    const logger = memoryLogger();
    const { call } = await start({
      logger,
      routes: new Map([['GET /boom', () => {
        throw new Error('handler broke');
      }]]),
    });
    const res = await call('/boom');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(logger.lines).toContainEqual(expect.objectContaining({ msg: 'internal request failed',
      method: 'GET',
      path: '/boom' }));
    expect((await call('/healthz')).status).toBe(200);
  });

  it('malformed request target is 500 and logged', async () => {
    const logger = memoryLogger();
    const { call, port } = await start({ logger });
    const socket = net.connect(port, '127.0.0.1');
    const reply = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk.toString('latin1'));
      });
    });

    socket.on('error', () => undefined);
    try {
      socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n');

      expect(await reply).toMatch(/^HTTP\/1\.1 500/u);
    } finally {
      socket.destroy();
    }
    expect(logger.lines).toContainEqual(expect.objectContaining({ msg: 'internal request failed' }));
    expect((await call('/healthz')).status).toBe(200);
  });

  it('query string is ignored', async () => {
    const { call } = await start();

    expect((await call('/healthz?x=1')).status).toBe(200);
  });
});
