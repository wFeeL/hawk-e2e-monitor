import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { FakeStore, StoredEvent } from './store.js';
import { decodeTokenKey } from './token.js';

const MAX_BODY_BYTES = 1_000_000;
const JSON_TYPE = 'text/json; charset=utf8';
const PLAIN_TYPE = 'text/plain; charset=utf-8';

/** A canned collector answer. */
export interface CollectorReplyOverride {
  /** HTTP status; ignored over WebSocket. */
  status: number;
  /** Response body as is. */
  body: string;
  /** Content-Type header, JSON type by default; ignored over WebSocket. */
  contentType?: string;
}

/** An override, or a function of the submission number (1, 2, ...) returning one. */
export type ReplyKnob = CollectorReplyOverride | ((submission: number) => CollectorReplyOverride | undefined);

/** Health knob: flags in the JSON body. */
export interface HealthFlags {
  /** HTTP status to answer with. */
  status: number;
  /** Value of `redis_status`. */
  redis: boolean;
  /** Value of `mongo_db_status`. */
  mongo: boolean;
}

/** Health knob: a plain text answer. */
export interface HealthText {
  /** HTTP status to answer with. */
  status: number;
  /** Response body. */
  text: string;
}

/** Failure switches of the fake collector; tests change them at any time. */
export interface FakeCollectorKnobs {
  /** Replaces the answer; the event is NOT accepted. */
  reply?: ReplyKnob;
  /** The event is accepted, but the answer is this one. */
  replyAfterAccept?: CollectorReplyOverride;
  /** Delay of the answer after accept. */
  replyDelayMs?: number;
  /** Answer of `/health`; by default 200 with both flags true. */
  health?: HealthFlags | HealthText;
  /** The monitor's IP is blacklisted: every request, including the upgrade, gets 429 before routing. */
  blacklisted?: boolean;
  /** WebSocket behavior. */
  ws?: 'normal' | 'reject_upgrade' | 'close_after_message' | 'silent';
  /** Accepts but never stores the event. */
  dropEvents?: boolean | ((submission: number) => boolean);
  /** Stores the event twice. */
  duplicateOnAccept?: boolean;
  /** Delay before the event reaches the store (real timers). */
  processingDelayMs?: number;
  /** Rewrites the payload before it is stored. */
  mutatePayload?: (payload: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Awaited before the answer of an accepted event, after its (possibly delayed) `ingest`.
   * Gets the stored event. Not called for dropped events or rejected messages.
   */
  holdReply?: (event: StoredEvent | undefined) => Promise<void>;
}

/** Running fake collector. */
export interface FakeCollector {
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** `ws://127.0.0.1:<port>/ws`. */
  readonly wsUrl: string;
  /** Mutable switches. */
  readonly knobs: FakeCollectorKnobs;
  /** Number of `POST /` requests of any outcome. */
  readonly posts: number;
  /** Number of WebSocket messages received. */
  readonly wsMessages: number;
  /**
   * Counts open WebSocket connections.
   * @returns Size of the server's client set.
   */
  wsClients(): number;
  /**
   * Stops the server, drops connections and cancels pending timers.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

/** Inputs of the fake collector. */
export interface FakeCollectorOptions {
  /** Where accepted events go. */
  store: FakeStore;
  /** Project the valid token belongs to. */
  projectId: string;
  /** `integrationId + secret` without dashes of the valid token. */
  validTokenKey: string;
  /** Answers 402 when it returns true. */
  blocked?: () => boolean;
  /** Port to listen on, to come back at the address of a collector that was closed; random by default. */
  port?: number;
}

/** Resolved answer of one message. */
interface Answer {
  /** HTTP status. */
  status: number;
  /** Body as is. */
  body: string;
  /** Content-Type header. */
  contentType: string;
  /** Delay before the answer is sent. */
  delayMs: number;
}

/**
 * Builds the handler's JSON answer.
 * @param code HTTP and body code.
 * @param message Body message.
 * @returns Answer without delay.
 */
function jsonAnswer(code: number, message: string): Answer {
  return { status: code,
    body: JSON.stringify({ code,
      error: code !== 200,
      message }),
    contentType: JSON_TYPE,
    delayMs: 0 };
}

/**
 * Reads a string field that must be a string when present.
 * @param record Parsed body.
 * @param key Field name.
 * @returns The string, '' when absent, undefined for another type.
 */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (value === undefined) {
    return '';
  }

  return typeof value === 'string' ? value : undefined;
}

/**
 * Starts a fake Hawk collector on a random loopback port.
 * @param options Store, project, valid token key and optional block switch.
 * @returns The running collector.
 */
export async function startFakeCollector(options: FakeCollectorOptions): Promise<FakeCollector> {
  const { store, projectId, validTokenKey } = options;
  const knobs: FakeCollectorKnobs = {};
  const timers = new Set<NodeJS.Timeout>();
  const wss = new WebSocketServer({ noServer: true });
  let posts = 0;
  let wsMessages = 0;
  let submissions = 0;

  const later = (action: () => void, delayMs: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      action();
    }, delayMs);

    timers.add(timer);
  };

  const ingest = (catcherType: string, payload: Record<string, unknown>): StoredEvent => store.ingest(projectId, catcherType, payload);

  /**
   * Stores the event.
   * @param submission Number of the submission.
   * @param catcherType Catcher type of the message.
   * @param payload Event payload.
   * @returns The stored event once stored, `'dropped'` when the knob drops it, undefined when the ingest is delayed and nobody holds the answer.
   */
  const accept = async (submission: number, catcherType: string, payload: Record<string, unknown>): Promise<StoredEvent | 'dropped' | undefined> => {
    const drop = typeof knobs.dropEvents === 'function' ? knobs.dropEvents(submission) : knobs.dropEvents === true;

    if (drop) {
      return 'dropped';
    }

    const stored = knobs.mutatePayload ? knobs.mutatePayload(structuredClone(payload)) : payload;
    const copies = knobs.duplicateOnAccept === true ? 2 : 1;
    const run = (): StoredEvent | undefined => {
      let last: StoredEvent | undefined;

      for (let copy = 0; copy < copies; copy += 1) {
        last = ingest(catcherType, structuredClone(stored));
      }

      return last;
    };

    if (knobs.processingDelayMs !== undefined && knobs.processingDelayMs > 0) {
      const delayed = new Promise<StoredEvent | undefined>((resolve) => {
        later(() => {
          resolve(run());
        }, knobs.processingDelayMs ?? 0);
      });

      // Without a hold the answer does not wait for the delayed ingest.
      return knobs.holdReply ? delayed : undefined;
    }

    return run();
  };

  const handleMessage = async (raw: string): Promise<Answer> => {
    submissions += 1;

    const submission = submissions;
    const override = typeof knobs.reply === 'function' ? knobs.reply(submission) : knobs.reply;

    if (override) {
      return { status: override.status,
        body: override.body,
        contentType: override.contentType ?? JSON_TYPE,
        delayMs: 0 };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonAnswer(400, 'Invalid JSON format');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonAnswer(400, 'Invalid JSON format');
    }

    const message = parsed as Record<string, unknown>;
    const token = stringField(message, 'token');
    const catcherType = stringField(message, 'catcherType');

    if (token === undefined || catcherType === undefined) {
      return jsonAnswer(400, 'Invalid JSON format');
    }

    if (!('payload' in message)) {
      return jsonAnswer(400, 'Payload is empty');
    }

    if (token === '') {
      return jsonAnswer(400, 'Token is empty');
    }

    if (catcherType === '') {
      return jsonAnswer(400, 'CatcherType is empty');
    }

    const key = decodeTokenKey(token);

    if (key === undefined) {
      return jsonAnswer(400, 'Token decoding error');
    }

    if (key !== validTokenKey) {
      return jsonAnswer(400, `Integration token invalid: ${key}`);
    }

    if (options.blocked?.() === true) {
      return jsonAnswer(402, 'Project has exceeded the events limit');
    }

    const { payload } = message;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return jsonAnswer(400, 'Invalid payload JSON format');
    }

    const stored = await accept(submission, catcherType, payload as Record<string, unknown>);

    if (stored !== 'dropped' && knobs.holdReply) {
      await knobs.holdReply(stored);
    }

    const answer = knobs.replyAfterAccept
      ? { status: knobs.replyAfterAccept.status,
          body: knobs.replyAfterAccept.body,
          contentType: knobs.replyAfterAccept.contentType ?? JSON_TYPE,
          delayMs: 0 }
      : jsonAnswer(200, 'OK');

    return { ...answer,
      delayMs: knobs.replyDelayMs ?? 0 };
  };

  const send = (response: ServerResponse, answer: Answer): void => {
    const write = (): void => {
      response.statusCode = answer.status;
      response.setHeader('content-type', answer.contentType);
      response.end(answer.body);
    };

    if (answer.delayMs > 0) {
      later(write, answer.delayMs);
    } else {
      write();
    }
  };

  const health = (response: ServerResponse): void => {
    const knob = knobs.health;

    if (knob && 'text' in knob) {
      send(response, { status: knob.status,
        body: knob.text,
        contentType: PLAIN_TYPE,
        delayMs: 0 });

      return;
    }

    const redis = knob?.redis ?? true;
    const mongo = knob?.mongo ?? true;
    const body = JSON.stringify(Object.fromEntries([['redis_status', redis], ['mongo_db_status', mongo]]));

    send(response, { status: knob?.status ?? (redis && mongo ? 200 : 500),
      body,
      contentType: JSON_TYPE,
      delayMs: 0 });
  };

  const notFound = (response: ServerResponse): void => {
    send(response, { status: 404,
      body: 'Not found',
      contentType: PLAIN_TYPE,
      delayMs: 0 });
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    if (knobs.blacklisted === true) {
      send(response, { status: 429,
        body: 'Too Many Requests',
        contentType: PLAIN_TYPE,
        delayMs: 0 });

      return;
    }

    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (pathname === '/health') {
      health(response);

      return;
    }

    if (pathname !== '/') {
      notFound(response);

      return;
    }

    if (request.method === 'POST') {
      posts += 1;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        send(response, { status: 413,
          body: 'Request is too large',
          contentType: PLAIN_TYPE,
          delayMs: 0 });

        return;
      }

      handleMessage(Buffer.concat(chunks).toString('utf8')).then((answer) => {
        send(response, answer);
      }, () => {
        send(response, { status: 500,
          body: 'Internal error',
          contentType: PLAIN_TYPE,
          delayMs: 0 });
      });
    });
  };

  const server: Server = createServer(handle);

  wss.on('connection', (socket) => {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      wsMessages += 1;

      handleMessage(data.toString('utf8')).then((answer) => {
        const mode = knobs.ws ?? 'normal';

        if (mode === 'close_after_message') {
          socket.close();
        } else if (mode === 'normal') {
          later(() => {
            if (socket.readyState === socket.OPEN) {
              socket.send(answer.body, { binary: isBinary });
            }
          }, answer.delayMs);
        }
      }, () => {
        socket.terminate();
      });
    });
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (knobs.blacklisted === true) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 17\r\n\r\nToo Many Requests');

      return;
    }

    if (request.url !== '/ws') {
      socket.destroy();

      return;
    }

    if (knobs.ws === 'reject_upgrade') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');

      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    knobs,
    get posts() {
      return posts;
    },
    get wsMessages() {
      return wsMessages;
    },
    wsClients: () => wss.clients.size,
    async close() {
      for (const timer of timers) {
        clearTimeout(timer);
      }

      timers.clear();

      for (const client of wss.clients) {
        client.terminate();
      }

      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
