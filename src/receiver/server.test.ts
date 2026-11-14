import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../log/logger.js';
import { createFakeClock } from '../test-support/fake-clock.js';
import { memoryLogger } from '../test-support/logger.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { startReceiver } from './server.js';
import type { Receiver, WaitOptions } from './server.js';

const SECRET = 'receiver-secret-0123456789-abcdef';
const BODY_MARKER = 'body-marker-7f3a';

const open: Receiver[] = [];

/** What a test may change about the receiver. */
interface StartOverrides {
  /** Clock; the system one by default. */
  clock?: Clock;
  /** Logger replacing the memory one. */
  logger?: Logger;
  /** Body limit. */
  maxBodyBytes?: number;
}

/** A started receiver with its memory logger. */
interface Started {
  /** Receiver under test. */
  receiver: Receiver;
  /** Logger of the receiver unless replaced. */
  logger: ReturnType<typeof memoryLogger>;
}

/** A wait whose end can be observed. */
interface TrackedWait {
  /** True once the wait has settled. */
  done: () => boolean;
  /** Outcome of the wait. */
  result: ReturnType<Receiver['wait']>;
}

/** A receiver on a fake clock. */
interface Clocked {
  /** Receiver under test. */
  receiver: Receiver;
  /** Clock the receiver uses. */
  clock: ReturnType<typeof createFakeClock>;
}

/**
 * Starts a receiver on a random port and closes it after the test.
 * @param overrides Logger, clock and body limit.
 * @returns Receiver and its logger.
 */
async function start(overrides: StartOverrides = {}): Promise<Started> {
  const logger = memoryLogger();
  const receiver = await startReceiver({ host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    clock: overrides.clock ?? systemClock,
    logger: overrides.logger ?? logger,
    ...overrides.maxBodyBytes === undefined ? {} : { maxBodyBytes: overrides.maxBodyBytes } });

  open.push(receiver);

  return { receiver,
    logger };
}

/**
 * Builds a URL of the receiver.
 * @param receiver Running receiver.
 * @param path Path after the host.
 * @returns Absolute URL.
 */
function url(receiver: Receiver, path: string): string {
  return `http://127.0.0.1:${String(receiver.port)}${path}`;
}

/**
 * Posts to a notification path.
 * @param receiver Running receiver.
 * @param kind `webhook` or `loop`.
 * @param body Raw body.
 * @returns Response.
 */
async function post(receiver: Receiver, kind: string, body: string): Promise<Response> {
  return fetch(url(receiver, `/hooks/${kind}/${SECRET}`), { method: 'POST',
    headers: new Headers([['content-type', 'application/json'], ['X-Hawk-Notification', 'event']]),
    body });
}

/**
 * Builds wait options with generous limits.
 * @param overrides Fields to replace.
 * @returns Options for one `wait` call, webhook only unless overridden.
 */
function waitOptions(overrides: Partial<WaitOptions> = {}): WaitOptions {
  return { channels: ['webhook'],
    timeoutMs: 5000,
    pairWaitMs: 1000,
    signal: new AbortController().signal,
    ...overrides };
}

/**
 * Waits until the receiver has counted a number of arrivals.
 * @param receiver Running receiver.
 * @param runId Run to look at.
 * @param channel Channel to count.
 * @param count Expected number.
 * @returns Resolves when the count is reached.
 */
async function arrived(receiver: Receiver, runId: string, channel: 'loop' | 'webhook', count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(receiver.counts(runId)[channel]).toHaveLength(count);
  });
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async receiver => receiver.close()));
});

describe('receiver', () => {
  it('expect then POST resolves wait', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');

    const waiting = receiver.wait('run-1', waitOptions());

    expect((await post(receiver, 'webhook', `{"title":"run-1"}`)).status).toBe(200);

    const arrivals = await waiting;

    expect(arrivals.webhook).toHaveLength(1);
    expect(arrivals.webhook[0]?.rawBody).toBe('{"title":"run-1"}');
    expect(arrivals.webhook[0]?.channel).toBe('webhook');
    expect(arrivals.webhook[0]?.headers['x-hawk-notification']).toBe('event');
    expect(arrivals.loop).toEqual([]);
    expect(arrivals.unmatched).toBe(0);
  });

  it('POST before wait is kept', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');
    await post(receiver, 'loop', 'text run-1');
    await arrived(receiver, 'run-1', 'loop', 1);

    const arrivals = await receiver.wait('run-1', waitOptions({ channels: ['loop'] }));

    expect(arrivals.loop).toHaveLength(1);
  });

  it('binds a POST to the run whose id is in the body', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');
    receiver.expect('run-2');
    await post(receiver, 'webhook', 'about run-2');
    await arrived(receiver, 'run-2', 'webhook', 1);

    expect(receiver.counts('run-1').webhook).toEqual([]);
    expect(receiver.counts('run-1').unmatched).toBe(0);
  });

  it('unmatched POST gets 200 and a log line', async () => {
    const { receiver, logger } = await start();

    receiver.expect('run-1');

    expect((await post(receiver, 'webhook', 'nothing here')).status).toBe(200);
    await vi.waitFor(() => {
      expect(receiver.counts('run-1').unmatched).toBe(1);
    });
    expect(logger.lines).toContainEqual({ level: 'warn',
      msg: 'unmatched notification',
      channel: 'webhook' });
  });

  it.each([
    ['wrong', 'x'.repeat(SECRET.length)],
    ['shorter', SECRET.slice(0, -1)],
    ['longer', `${SECRET}x`],
    ['empty', ''],
  ])('%s secret is 404', async (_name, secret) => {
    const { receiver } = await start();
    const response = await fetch(url(receiver, `/hooks/webhook/${secret}`), { method: 'POST',
      body: 'run-1' });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
    expect((await fetch(url(receiver, `/hooks/probe/${SECRET}`))).status).toBe(200);
  });

  it('broken body does not crash', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');

    const response = await post(receiver, 'webhook', '{"broken": ');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    await vi.waitFor(() => {
      expect(receiver.counts('run-1').unmatched).toBe(1);
    });
    expect((await fetch(url(receiver, `/hooks/probe/${SECRET}`))).status).toBe(200);
  });

  it('body over the limit is 413', async () => {
    const { receiver } = await start({ maxBodyBytes: 100 });
    const status = await new Promise<number>((resolve, reject) => {
      const clientRequest = request(url(receiver, `/hooks/webhook/${SECRET}`), { method: 'POST' }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });

      clientRequest.on('error', reject);
      clientRequest.end('x'.repeat(200));
    });

    expect(status).toBe(413);
    expect((await fetch(url(receiver, `/hooks/probe/${SECRET}`))).status).toBe(200);
  });

  it('log has no path, secret or body', async () => {
    const { receiver, logger } = await start();

    receiver.expect('run-1');
    await post(receiver, 'webhook', `${BODY_MARKER} run-1`);
    await post(receiver, 'loop', BODY_MARKER);
    await fetch(url(receiver, `/hooks/webhook/wrong-${SECRET}`), { method: 'POST' });
    await vi.waitFor(() => {
      expect(receiver.counts('run-1').unmatched).toBe(1);
    });

    const text = JSON.stringify(logger.lines);

    expect(logger.lines.length).toBeGreaterThan(0);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('/hooks');
    expect(text).not.toContain(BODY_MARKER);
  });

  it('an exception after the reply is logged by name and the server survives', async () => {
    const inner = memoryLogger();
    const logger: Logger = { ...inner,
      warn: () => {
        throw new TypeError('boom /hooks/webhook/secret');
      } };
    const { receiver } = await start({ logger });

    expect((await post(receiver, 'webhook', 'unmatched')).status).toBe(200);
    await vi.waitFor(() => {
      expect(inner.lines).toContainEqual({ level: 'error',
        msg: 'receiver handler failed',
        error: 'TypeError' });
    });
    expect((await fetch(url(receiver, `/hooks/probe/${SECRET}`))).status).toBe(200);
  });

  it('wait returns on signal without throwing', async () => {
    const { receiver } = await start();
    const controller = new AbortController();

    receiver.expect('run-1');
    await post(receiver, 'loop', 'run-1');
    await arrived(receiver, 'run-1', 'loop', 1);

    const waiting = receiver.wait('run-1', waitOptions({ channels: ['webhook', 'loop'],
      timeoutMs: 60_000,
      pairWaitMs: 30_000,
      signal: controller.signal }));

    controller.abort();

    expect((await waiting).loop).toHaveLength(1);
  });

  it('wait of an unknown run returns empty arrivals', async () => {
    const { receiver } = await start();

    expect(await receiver.wait('nope', waitOptions())).toEqual({ webhook: [],
      loop: [],
      unmatched: 0 });
  });

  it('counts sees a late duplicate until release', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');
    await post(receiver, 'webhook', 'run-1');
    await arrived(receiver, 'run-1', 'webhook', 1);
    await post(receiver, 'webhook', 'run-1');
    await arrived(receiver, 'run-1', 'webhook', 2);
    receiver.release('run-1');

    expect(receiver.counts('run-1')).toEqual({ webhook: [],
      loop: [],
      unmatched: 0 });
  });

  it('after release the run id is no longer matched', async () => {
    const { receiver } = await start();

    receiver.expect('run-1');
    receiver.release('run-1');
    receiver.expect('run-2');
    await post(receiver, 'webhook', 'run-1');
    await vi.waitFor(() => {
      expect(receiver.counts('run-2').unmatched).toBe(1);
    });
  });

  it('probe returns the nonce', async () => {
    const { receiver } = await start();
    const response = await fetch(url(receiver, `/hooks/probe/${SECRET}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe(receiver.nonce);
    expect(receiver.nonce).toMatch(/^[0-9a-f]{32}$/u);
  });

  it.each([
    ['GET', '/hooks/webhook/SECRET'],
    ['GET', '/hooks/loop/SECRET'],
    ['POST', '/hooks/probe/SECRET'],
    ['PUT', '/hooks/webhook/SECRET'],
    ['POST', '/hooks/other/SECRET'],
    ['POST', '/hooks/webhook'],
    ['POST', '/hooks/webhook/SECRET/'],
    ['POST', '/hooks/webhook/SECRET/more'],
    ['GET', '/'],
  ])('%s %s is 404', async (method, path) => {
    const { receiver } = await start();
    const response = await fetch(url(receiver, path.replace('SECRET', SECRET)), { method });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});

describe('wait on a fake clock', () => {
  /**
   * Starts a receiver on a fake clock.
   * @returns Receiver and clock.
   */
  async function onFakeClock(): Promise<Clocked> {
    const clock = createFakeClock();
    const { receiver } = await start({ clock });

    return { receiver,
      clock };
  }

  /**
   * Starts a wait and reports whether it settled.
   * @param receiver Running receiver.
   * @param options Wait options.
   * @returns Promise of the arrivals and a settled flag.
   */
  function track(receiver: Receiver, options: WaitOptions): TrackedWait {
    let settled = false;
    const result = receiver.wait('run-1', options).finally(() => {
      settled = true;
    });

    return { done: () => settled,
      result };
  }

  it('waits for the second channel only pairWaitMs after the first one arrived', async () => {
    const { receiver, clock } = await onFakeClock();

    receiver.expect('run-1');

    const waiting = track(receiver, waitOptions({ channels: ['webhook', 'loop'],
      timeoutMs: 10_000,
      pairWaitMs: 700 }));

    await clock.advance(300);
    await post(receiver, 'webhook', 'run-1');
    await arrived(receiver, 'run-1', 'webhook', 1);
    await clock.advance(699);

    expect(waiting.done()).toBe(false);

    await clock.advance(1);

    const arrivals = await waiting.result;

    expect(arrivals.webhook).toHaveLength(1);
    expect(arrivals.loop).toEqual([]);
    expect(arrivals.webhook[0]?.atMs).toBe(300);
  });

  it('resolves at once when both channels have arrived', async () => {
    const { receiver } = await onFakeClock();

    receiver.expect('run-1');
    await post(receiver, 'webhook', 'run-1');
    await post(receiver, 'loop', 'run-1');
    await arrived(receiver, 'run-1', 'loop', 1);
    await arrived(receiver, 'run-1', 'webhook', 1);

    const arrivals = await receiver.wait('run-1', waitOptions({ channels: ['webhook', 'loop'] }));

    expect(arrivals.webhook).toHaveLength(1);
    expect(arrivals.loop).toHaveLength(1);
  });

  it('the pair wait never outlasts timeoutMs', async () => {
    const { receiver, clock } = await onFakeClock();

    receiver.expect('run-1');

    const waiting = track(receiver, waitOptions({ channels: ['webhook', 'loop'],
      timeoutMs: 1000,
      pairWaitMs: 500 }));

    await clock.advance(900);
    await post(receiver, 'loop', 'run-1');
    await arrived(receiver, 'run-1', 'loop', 1);
    await clock.advance(99);

    expect(waiting.done()).toBe(false);

    await clock.advance(1);
    expect((await waiting.result).loop).toHaveLength(1);
  });

  it('a late pair partner after the first arrival moves nothing', async () => {
    const { receiver, clock } = await onFakeClock();

    receiver.expect('run-1');
    await post(receiver, 'webhook', 'run-1');
    await arrived(receiver, 'run-1', 'webhook', 1);
    await clock.advance(5000);

    const arrivals = await receiver.wait('run-1', waitOptions({ channels: ['webhook', 'loop'],
      pairWaitMs: 1000 }));

    expect(arrivals.webhook).toHaveLength(1);
  });

  it('gives up at timeoutMs when nothing arrived', async () => {
    const { receiver, clock } = await onFakeClock();

    receiver.expect('run-1');

    const waiting = track(receiver, waitOptions({ timeoutMs: 1000 }));

    await clock.advance(999);

    expect(waiting.done()).toBe(false);

    await clock.advance(1);

    expect(await waiting.result).toEqual({ webhook: [],
      loop: [],
      unmatched: 0 });
  });

  it('clears its timers when it settles', async () => {
    const { receiver, clock } = await onFakeClock();

    receiver.expect('run-1');

    const waiting = receiver.wait('run-1', waitOptions({ timeoutMs: 5000 }));

    await post(receiver, 'webhook', 'run-1');
    await waiting;

    expect(clock.pending()).toBe(0);
  });
});
