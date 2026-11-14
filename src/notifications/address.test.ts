import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckError } from '../errors/taxonomy.js';
import { startReceiver } from '../receiver/server.js';
import type { Receiver } from '../receiver/server.js';
import { startFakeTunnelMetrics } from '../test-support/fake-tunnel.js';
import type { FakeTunnelMetrics, TunnelAnswer } from '../test-support/fake-tunnel.js';
import { memoryLogger } from '../test-support/logger.js';
import { systemClock } from '../time/clock.js';
import { probeReceiver, resolvePublicAddress } from './address.js';
import type { PublicAddress } from './address.js';

const SECRET = 'address-secret-0123456789-abcdefgh';
const DEPS = { httpTimeoutMs: 500,
  clock: systemClock,
  retryDelaysMs: [1, 1] };
const signal = new AbortController().signal;

/** A running receiver with the address that reaches it. */
interface RunningReceiver {
  /** Receiver under test. */
  running: Receiver;
  /** Address of the receiver. */
  address: PublicAddress;
}

const tunnels: FakeTunnelMetrics[] = [];
const receivers: Receiver[] = [];
const servers: ReturnType<typeof createServer>[] = [];

/**
 * Starts a fake tunnel that is closed after the test.
 * @param answer Answer of the fake.
 * @returns Running fake.
 */
async function tunnel(answer: () => TunnelAnswer): Promise<FakeTunnelMetrics> {
  const fake = await startFakeTunnelMetrics(answer);

  tunnels.push(fake);

  return fake;
}

/**
 * Starts a receiver that is closed after the test.
 * @returns Running receiver and its address.
 */
async function receiver(): Promise<RunningReceiver> {
  const running = await startReceiver({ host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    clock: systemClock,
    logger: memoryLogger() });

  receivers.push(running);

  return { running,
    address: { baseUrl: `http://127.0.0.1:${String(running.port)}`,
      hostname: `127.0.0.1:${String(running.port)}`,
      source: 'config' } };
}

/**
 * Catches what a promise rejects with.
 * @param promise Promise expected to reject.
 * @returns The rejection as a CheckError.
 */
async function failure(promise: Promise<unknown>): Promise<CheckError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CheckError);

    return error as CheckError;
  }

  throw new Error('Expected a rejection');
}

afterEach(async () => {
  await Promise.all([...tunnels.splice(0).map(async fake => fake.close()),
    ...receivers.splice(0).map(async running => running.close()),
    ...servers.splice(0).map(async server => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }))]);
});

describe('resolvePublicAddress', () => {
  it('config address wins', async () => {
    const fake = await tunnel(() => ({ status: 200,
      body: '{"hostname":"other.trycloudflare.com"}' }));
    const address = await resolvePublicAddress({ publicBaseUrl: 'https://hooks.example.com/',
      tunnelMetricsUrl: fake.url }, DEPS, signal);

    expect(address).toEqual({ baseUrl: 'https://hooks.example.com',
      hostname: 'hooks.example.com',
      source: 'config' });
    expect(fake.hits()).toBe(0);
  });

  it('tunnel hostname becomes https base', async () => {
    const fake = await tunnel(() => ({ status: 200,
      body: '{"hostname":"quiet-fox.trycloudflare.com"}' }));
    const address = await resolvePublicAddress({ tunnelMetricsUrl: `${fake.url}/` }, DEPS, signal);

    expect(address).toEqual({ baseUrl: 'https://quiet-fox.trycloudflare.com',
      hostname: 'quiet-fox.trycloudflare.com',
      source: 'tunnel' });
  });

  it.each([
    ['500', { status: 500,
      body: 'oops' }],
    ['not JSON', { status: 200,
      body: 'not json' }],
    ['empty hostname', { status: 200,
      body: '{"hostname":""}' }],
    ['no hostname', { status: 200,
      body: '{}' }],
    ['hostname that is not a string', { status: 200,
      body: '{"hostname":5}' }],
    ['404', { status: 404,
      body: '' }],
  ])('tunnel %s is tunnel_unavailable', async (_name, answer) => {
    const fake = await tunnel(() => answer);
    const error = await failure(resolvePublicAddress({ tunnelMetricsUrl: fake.url }, DEPS, signal));

    expect(error.errorClass).toBe('tunnel_unavailable');
    expect(error.culprit).toBe('monitor');
    expect(error.facts.url).toBe(`${fake.url}/quicktunnel`);
    expect(error.facts.detail).toBeDefined();
  });

  it('retries a 500 and stops at 404', async () => {
    const failing = await tunnel(() => ({ status: 500,
      body: '' }));
    const missing = await tunnel(() => ({ status: 404,
      body: '' }));

    await failure(resolvePublicAddress({ tunnelMetricsUrl: failing.url }, DEPS, signal));
    await failure(resolvePublicAddress({ tunnelMetricsUrl: missing.url }, DEPS, signal));

    expect(failing.hits()).toBe(3);
    expect(missing.hits()).toBe(1);
  });

  it('recovers when the tunnel answers on a later attempt', async () => {
    let calls = 0;
    const fake = await tunnel(() => {
      calls += 1;
      if (calls < 3) {
        return { status: 503,
          body: '' };
      }

      return { status: 200,
        body: '{"hostname":"late.trycloudflare.com"}' };
    });

    expect((await resolvePublicAddress({ tunnelMetricsUrl: fake.url }, DEPS, signal)).baseUrl).toBe('https://late.trycloudflare.com');
  });

  it('a closed port is tunnel_unavailable', async () => {
    const fake = await tunnel(() => ({ status: 200,
      body: '{}' }));

    await fake.close();
    tunnels.length = 0;

    const error = await failure(resolvePublicAddress({ tunnelMetricsUrl: fake.url }, DEPS, signal));

    expect(error.errorClass).toBe('tunnel_unavailable');
  });

  it('without any address it is an internal error', async () => {
    expect((await failure(resolvePublicAddress({}, DEPS, signal))).errorClass).toBe('monitor_internal');
  });
});

describe('probeReceiver', () => {
  it('probe through the receiver passes', async () => {
    const { running, address } = await receiver();

    await expect(probeReceiver(address, SECRET, running.nonce, { ...DEPS,
      attempts: 3 }, signal)).resolves.toBeUndefined();
  });

  it('probe on a closed port is receiver_unreachable', async () => {
    const { running, address } = await receiver();

    await running.close();
    receivers.length = 0;

    const error = await failure(probeReceiver(address, SECRET, running.nonce, { ...DEPS,
      attempts: 3 }, signal));

    expect(error.errorClass).toBe('receiver_unreachable');
    expect(error.culprit).toBe('monitor');
  });

  it('probe with a wrong nonce is receiver_unreachable', async () => {
    const { address } = await receiver();
    const error = await failure(probeReceiver(address, SECRET, 'not-the-nonce', { ...DEPS,
      attempts: 3 }, signal));

    expect(error.errorClass).toBe('receiver_unreachable');
    expect(error.facts.detail).toContain('nonce');
  });

  it('probe with a wrong secret is receiver_unreachable', async () => {
    const { running, address } = await receiver();
    const error = await failure(probeReceiver(address, `${SECRET}x`, running.nonce, { ...DEPS,
      attempts: 3 }, signal));

    expect(error.facts.detail).toContain('404');
  });

  it('probe detail hides the secret', async () => {
    const { running, address } = await receiver();
    const closed = { ...address,
      baseUrl: 'http://127.0.0.1:1' };
    const errors = [
      await failure(probeReceiver(address, SECRET, 'wrong', { ...DEPS,
        attempts: 1 }, signal)),
      await failure(probeReceiver(closed, SECRET, running.nonce, { ...DEPS,
        attempts: 1 }, signal)),
      await failure(probeReceiver(address, `${SECRET}x`, running.nonce, { ...DEPS,
        attempts: 1 }, signal)),
    ];

    for (const error of errors) {
      const text = JSON.stringify({ message: error.message,
        facts: error.facts,
        cause: error.cause });

      expect(text).not.toContain(SECRET);
      expect(error.message).toContain('/hooks/probe/…');
    }
  });

  it('single attempt does not retry', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      req.resume();
      res.writeHead(503);
      res.end();
    });

    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const address: PublicAddress = { baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
      hostname: 'x',
      source: 'config' };

    await failure(probeReceiver(address, SECRET, 'n', { ...DEPS,
      attempts: 1 }, signal));
    expect(hits).toBe(1);

    await failure(probeReceiver(address, SECRET, 'n', { ...DEPS,
      attempts: 3 }, signal));
    expect(hits).toBe(4);
  });
});
