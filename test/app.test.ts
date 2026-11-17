import type { Buffer } from 'node:buffer';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startApp, StartupError } from '../src/app.js';
import type { AppHandle } from '../src/app.js';
import { testConfig } from './support/config.js';
import { createFakeClock } from './support/fake-clock.js';
import type { FakeClock } from './support/fake-clock.js';
import { memoryLogger } from './support/logger.js';

const TIMEOUT_MS = 200;
const SETTLE_MS = 50;

const running: AppHandle[] = [];

/**
 * Starts the app and registers it for cleanup.
 * @param overrides Config overrides.
 * @param liveness Liveness checks.
 * @param clock Clock of the shutdown cut and the checks.
 * @returns Running app.
 */
async function launch(overrides: Parameters<typeof testConfig>[0] = {}, liveness: Parameters<typeof startApp>[1]['liveness'] = [], clock: FakeClock = createFakeClock()): Promise<AppHandle> {
  const app = await startApp(testConfig(overrides), { logger: memoryLogger(),
    clock,
    liveness });

  running.push(app);

  return app;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async app => app.stop()));
});

describe('startApp', () => {
  it('serves healthz on the returned port', async () => {
    const app = await launch();
    const res = await fetch(`http://127.0.0.1:${String(app.port)}/healthz`);

    expect(app.port).toBeGreaterThan(0);
    expect(res.status).toBe(200);
  });

  it('stop closes the port', async () => {
    const app = await launch();

    await fetch(`http://127.0.0.1:${String(app.port)}/healthz`);
    await app.stop();

    await expect(fetch(`http://127.0.0.1:${String(app.port)}/healthz`)).rejects.toThrow();
  });

  it('stop is idempotent', async () => {
    const app = await launch();
    const first = app.stop();
    const second = app.stop();

    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toBeDefined();
  });

  it('shutdown closes busy connections when the fake clock passes the shutdown timeout', async () => {
    const clock = createFakeClock();
    const app = await launch({ shutdownTimeoutMs: TIMEOUT_MS }, [], clock);
    const socket = net.connect(app.port, '127.0.0.1');
    const noop = (): void => undefined;

    socket.on('error', noop);
    try {
      const answered = new Promise<void>((resolve) => {
        socket.once('data', (_chunk: Buffer) => {
          resolve();
        });
      });

      socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n');
      await answered;
      socket.write('GET /healthz HTTP/1.1\r\nHost: x\r\n');
      await new Promise((resolve) => {
        setTimeout(resolve, SETTLE_MS);
      });

      let stopped = false;
      const stopping = app.stop().then(() => {
        stopped = true;
      });

      await vi.waitFor(() => {
        expect(clock.pending()).toBe(1);
      });
      await clock.advance(TIMEOUT_MS - 1);
      expect(stopped).toBe(false);
      await clock.advance(1);
      await stopping;
      expect(stopped).toBe(true);
      expect(clock.pending()).toBe(0);
    } finally {
      socket.destroy();
    }
  });

  it('busy port is a StartupError', async () => {
    const first = await launch();
    const second = startApp(testConfig({ internal: { host: '127.0.0.1',
      port: first.port } }), { logger: memoryLogger(),
      clock: createFakeClock() });

    await expect(second).rejects.toBeInstanceOf(StartupError);
    await expect(second).rejects.toThrow('is already in use');
    await expect(second).rejects.toThrow(`INTERNAL_PORT ${String(first.port)}`);
  });

  it('liveness checks are wired', async () => {
    const app = await launch({}, [{ name: 'scheduler',
      run: () => Promise.resolve(false) }]);
    const res = await fetch(`http://127.0.0.1:${String(app.port)}/healthz`);

    expect(res.status).toBe(503);
  });

  it('extra routes are wired', async () => {
    const app = await startApp(testConfig(), { logger: memoryLogger(),
      clock: createFakeClock(),
      routes: new Map([['GET /extra', (_req, res) => {
        res.writeHead(200).end('extra');
      }]]) });

    running.push(app);
    expect(await (await fetch(`http://127.0.0.1:${String(app.port)}/extra`)).text()).toBe('extra');
  });
});
