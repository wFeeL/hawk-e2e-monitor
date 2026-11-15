import type { Buffer } from 'node:buffer';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startApp, StartupError } from './app.js';
import type { AppHandle } from './app.js';
import { testConfig } from './test-support/config.js';
import { memoryLogger } from './test-support/logger.js';

const BUDGET_MS = 200;
const SETTLE_MS = 50;
const MIN_STOP_MS = 150;
const MAX_STOP_MS = 1000;

const running: AppHandle[] = [];

/**
 * Starts the app and registers it for cleanup.
 * @param overrides Config overrides.
 * @param liveness Liveness checks.
 * @returns Running app.
 */
async function launch(overrides: Parameters<typeof testConfig>[0] = {}, liveness: Parameters<typeof startApp>[1]['liveness'] = []): Promise<AppHandle> {
  const app = await startApp(testConfig(overrides), { logger: memoryLogger(),
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

  it('stop does not wait for hanging connections longer than the budget', async () => {
    const app = await launch({ shutdownTimeoutMs: BUDGET_MS });
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

      const started = performance.now();

      await app.stop();

      const elapsed = performance.now() - started;

      expect(elapsed).toBeGreaterThanOrEqual(MIN_STOP_MS);
      expect(elapsed).toBeLessThan(MAX_STOP_MS);
    } finally {
      socket.destroy();
    }
  });

  it('busy port is a StartupError', async () => {
    const first = await launch();
    const second = startApp(testConfig({ internal: { host: '127.0.0.1',
      port: first.port } }), { logger: memoryLogger() });

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
      routes: new Map([['GET /extra', (_req, res) => {
        res.writeHead(200).end('extra');
      }]]) });

    running.push(app);
    expect(await (await fetch(`http://127.0.0.1:${String(app.port)}/extra`)).text()).toBe('extra');
  });
});
