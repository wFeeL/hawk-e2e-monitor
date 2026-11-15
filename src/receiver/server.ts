import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../log/logger.js';
import { ARRIVAL_KINDS } from '../notifications/types.js';
import type { ArrivalKind } from '../notifications/types.js';
import type { Clock } from '../time/clock.js';
import { HttpStatus } from '../net/http-status.js';

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const NONCE_BYTES = 16;
const PATH_SEGMENTS = 4;

/** One POST that was bound to a run. */
export interface Arrival {
  /** Channel the POST came through. */
  channel: ArrivalKind;
  /** Monotonic time of the arrival. */
  atMs: number;
  /** Request headers, names in lower case. */
  headers: Record<string, string>;
  /** Body text as received. */
  rawBody: string;
}

/** What the receiver collected for a run. */
export interface Arrivals {
  /** POSTs of the webhook channel. */
  webhook: Arrival[];
  /** POSTs of the loop channel. */
  loop: Arrival[];
  /** POSTs of the threshold webhook. */
  threshold: Arrival[];
  /** POSTs of the webhook of the Telegram rule. */
  telegram: Arrival[];
  /** POSTs that matched no run while the run was waiting. */
  unmatched: number;
}

/** Limits of one `wait`. */
export interface WaitOptions {
  /** Channels the caller needs. */
  channels: readonly ArrivalKind[];
  /** Longest wait. */
  timeoutMs: number;
  /** Time to wait for the missing channels after the first arrival. */
  pairWaitMs: number;
  /** Ends the wait early. */
  signal: AbortSignal;
}

/** Accepts the notifications of Hawk and hands them to runs. */
export interface Receiver {
  /** Port the server listens on. */
  readonly port: number;
  /** Random value that `probe` returns, so a probe proves it reached this process. */
  readonly nonce: string;
  /**
   * Registers a run before its event is sent.
   * @param runId Id that the notification body contains.
   */
  expect(runId: string): void;
  /**
   * Waits for the notification channels of a run; never throws.
   * @param runId Registered run.
   * @param options Channels, time limits and abort signal.
   * @returns What has arrived when the wait ended.
   */
  wait(runId: string, options: WaitOptions): Promise<Arrivals>;
  /**
   * Reads what a run has received so far.
   * @param runId Registered run.
   * @returns Copy of the arrivals; empty for an unknown run.
   */
  counts(runId: string): Arrivals;
  /**
   * Forgets a run; later POSTs for it count as unmatched.
   * @param runId Registered run.
   */
  release(runId: string): void;
  /**
   * Stops the server and drops open connections.
   * @returns Resolves when the server is closed.
   */
  close(): Promise<void>;
}

/** Settings of `startReceiver`. */
export interface ReceiverOptions {
  /** Interface to listen on. */
  host: string;
  /** TCP port; 0 lets the OS choose. */
  port: number;
  /** Secret part of the paths. */
  secret: string;
  /** Time source and sleeper. */
  clock: Clock;
  /** Logger; it gets neither paths nor bodies. */
  logger: Logger;
  /** Largest accepted body, 1 MiB by default. */
  maxBodyBytes?: number;
  /** Called for every POST with a valid secret that belongs to no registered run; a failure is logged and ignored. */
  onUnmatched?: (channel: ArrivalKind, rawBody: string, atMs: number) => void;
}

/** State of a registered run. */
interface RunState {
  /** What the run has received. */
  arrivals: Arrivals;
  /** Called after every change of `arrivals`. */
  listeners: Set<() => void>;
}

/**
 * Hashes a value so comparisons run on equal lengths.
 * @param value Text to hash.
 * @returns SHA-256 digest.
 */
function digest(value: string): Buffer {
  return createHash('sha256')
    .update(value)
    .digest();
}

/**
 * Copies arrivals so callers cannot change the registry.
 * @param arrivals Arrivals to copy.
 * @returns Copy with its own arrays.
 */
function snapshot(arrivals: Arrivals): Arrivals {
  return { webhook: [...arrivals.webhook],
    loop: [...arrivals.loop],
    threshold: [...arrivals.threshold],
    telegram: [...arrivals.telegram],
    unmatched: arrivals.unmatched };
}

/**
 * Joins repeated headers and lower-cases nothing: Node already lower-cases names.
 * @param headers Headers of the request.
 * @returns Plain record of strings.
 */
function flattenHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[name] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  return result;
}

/**
 * Reads a request body up to a limit.
 * @param req Request.
 * @param limit Largest accepted size in bytes.
 * @returns Body text, or undefined when it is larger than the limit.
 */
async function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;

    size += buffer.length;
    if (size > limit) {
      return undefined;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Sends a status without a body.
 * @param res Response.
 * @param status HTTP status.
 */
function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

/**
 * Starts the receiver server.
 * @param options Address, secret, clock and logger.
 * @returns Running receiver.
 */
export async function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const { clock, logger } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const secretDigest = digest(options.secret);
  const nonce = randomBytes(NONCE_BYTES).toString('hex');
  // Map order is the order of `expect`, so the first expected run wins a tie.
  const runs = new Map<string, RunState>();

  const bind = (channel: ArrivalKind, headers: Record<string, string>, rawBody: string): void => {
    const matched = [...runs.entries()].find(([runId]) => rawBody.includes(runId));

    if (matched) {
      matched[1].arrivals[channel].push({ channel,
        atMs: clock.monotonicMs(),
        headers,
        rawBody });
      for (const listener of matched[1].listeners) {
        listener();
      }

      return;
    }

    for (const run of runs.values()) {
      run.arrivals.unmatched += 1;
    }
    logger.warn('unmatched notification', { channel });

    try {
      options.onUnmatched?.(channel, rawBody, clock.monotonicMs());
    } catch (error) {
      logger.error('unmatched callback failed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://receiver').pathname;
    const segments = pathname.split('/');
    const kind = segments[2];
    const given = segments[3];
    const method = req.method ?? '';
    const known = segments.length === PATH_SEGMENTS && segments[1] === 'hooks' && kind !== undefined && given !== undefined
      && timingSafeEqual(digest(given), secretDigest);
    const isProbe = kind === 'probe' && method === 'GET';
    const channel = ARRIVAL_KINDS.find(name => name === kind);

    if (!known || (!isProbe && !(channel !== undefined && method === 'POST'))) {
      sendEmpty(res, HttpStatus.notFound);

      return;
    }

    if (isProbe) {
      res.statusCode = HttpStatus.ok;
      res.setHeader('content-type', 'text/plain');
      res.end(nonce);

      return;
    }

    const body = await readBody(req, maxBodyBytes);

    if (body === undefined || channel === undefined) {
      res.writeHead(HttpStatus.payloadTooLarge, { connection: 'close' });
      res.end(() => {
        req.destroy();
      });

      return;
    }

    // Hawk waits for the answer with a short idle timeout, so answer before binding.
    sendEmpty(res, HttpStatus.ok);
    bind(channel, flattenHeaders(req.headers), body);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error('receiver handler failed', { error: error instanceof Error ? error.name : 'unknown' });
      if (res.headersSent) {
        res.destroy();
      } else {
        sendEmpty(res, HttpStatus.internalServerError);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;

  const wait = async (runId: string, waitOptions: WaitOptions): Promise<Arrivals> => {
    const run = runs.get(runId);

    if (run === undefined) {
      return { webhook: [],
        loop: [],
        threshold: [],
        telegram: [],
        unmatched: 0 };
    }

    const timers = new AbortController();
    const startedAt = clock.monotonicMs();
    let listener: (() => void) | undefined;
    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve) => {
        let pairStarted = false;
        const ignore = (): void => undefined;
        const arrivedAt = (): number[] => waitOptions.channels.flatMap(channel => run.arrivals[channel].map(arrival => arrival.atMs));

        listener = (): void => {
          if (waitOptions.channels.every(channel => run.arrivals[channel].length > 0)) {
            resolve();

            return;
          }

          const first = Math.min(...arrivedAt());

          if (pairStarted || first === Infinity) {
            return;
          }
          pairStarted = true;

          const remaining = Math.min(first + waitOptions.pairWaitMs, startedAt + waitOptions.timeoutMs) - clock.monotonicMs();

          if (remaining <= 0) {
            resolve();
          } else {
            clock.sleep(remaining, timers.signal).then(resolve, ignore);
          }
        };
        onAbort = (): void => {
          resolve();
        };
        run.listeners.add(listener);
        waitOptions.signal.addEventListener('abort', onAbort, { once: true });
        clock.sleep(waitOptions.timeoutMs, timers.signal).then(resolve, ignore);
        if (waitOptions.signal.aborted) {
          resolve();
        }
        listener();
      });
    } finally {
      timers.abort();
      if (listener) {
        run.listeners.delete(listener);
      }
      if (onAbort) {
        waitOptions.signal.removeEventListener('abort', onAbort);
      }
    }

    return snapshot(run.arrivals);
  };

  const expect: Receiver['expect'] = (runId) => {
    if (!runs.has(runId)) {
      runs.set(runId, { arrivals: { webhook: [],
        loop: [],
        threshold: [],
        telegram: [],
        unmatched: 0 },
      listeners: new Set() });
    }
  };

  const release: Receiver['release'] = (runId) => {
    runs.delete(runId);
  };

  const close: Receiver['close'] = async () => new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });

  return {
    port,
    nonce,
    expect,
    wait,
    counts: runId => snapshot(runs.get(runId)?.arrivals ?? { webhook: [],
      loop: [],
      threshold: [],
      telegram: [],
      unmatched: 0 }),
    release,
    close,
  };
}
