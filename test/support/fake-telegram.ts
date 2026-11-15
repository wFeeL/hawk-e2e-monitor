import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Methods the fake Bot API answers. */
export type FakeTelegramMethod = 'getChatMember' | 'getMe' | 'getUpdates' | 'getWebhookInfo';

/** A message the test puts into the chat. */
export interface FakeTelegramMessage {
  /** Id of the chat, -1001 by default. */
  chatId?: number;
  /** Type of the chat, `supergroup` by default. */
  chatType?: string;
  /** Username of the sender; absent for a sender without one. */
  fromUsername?: string;
  /** Whether the sender is a bot, true by default. */
  fromIsBot?: boolean;
  /** Text of the message. */
  text: string;
}

/** Switches a test sets to break the fake or change what it says. */
export interface FakeTelegramKnobs {
  /** Forces the HTTP status of a method; the body is a Bot API error with that code. */
  status?: Partial<Record<FakeTelegramMethod, number>>;
  /** Text sent as the body of a method instead of JSON. */
  rawBody?: Partial<Record<FakeTelegramMethod, string>>;
  /** Seconds in `parameters.retry_after` of a 429. */
  retryAfter?: number;
  /** Group privacy mode on: the bot cannot read all group messages. */
  privacyOn?: boolean;
  /** Address of the webhook that `getWebhookInfo` reports, empty when none. */
  webhookUrl?: string;
  /** Status `getChatMember` reports, `administrator` by default. */
  memberStatus?: string;
  /** Longest time a long poll waits, ms; the `timeout` of the request when absent. 0 makes every poll return at once. */
  holdMs?: number;
  /** Pause before every answer, ms. */
  delayMs?: number;
}

/** A request the fake received. */
export interface FakeTelegramRequest {
  /** Method name. */
  method: string;
  /** Query and JSON body parameters together. */
  params: Record<string, unknown>;
  /** Path of the request, token included. */
  path: string;
}

/** Running fake of the Telegram Bot API. */
export interface FakeTelegram {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Token the fake accepts. */
  readonly token: string;
  /** Id of the bot. */
  readonly botId: number;
  /** Mutable switches. */
  readonly knobs: FakeTelegramKnobs;
  /** Requests in arrival order. */
  readonly requests: FakeTelegramRequest[];
  /**
   * Puts a message into the update queue and wakes the long polls.
   * @param message Message to add.
   * @returns Id of the update.
   */
  push(message: FakeTelegramMessage): number;
  /**
   * Puts an update that is not a message into the queue.
   * @returns Id of the update.
   */
  pushOther(): number;
  /**
   * Stops the server, drops connections and wakes the long polls.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

/** Holder of a timer that its own callback has to clear. */
interface TimerHandle {
  /** The running timer. */
  timer?: NodeJS.Timeout;
}

/** An update waiting in the queue, in the shape of the Bot API; its `update_id` is a number. */
type QueuedUpdate = Record<string, unknown>;

const BOT_ID = 777_000;
const TOKEN = `${String(BOT_ID)}:AAFake-token-for-tests_0123456789abcdef`;
const FIRST_UPDATE_ID = 500;
const DEFAULT_CHAT_ID = -1001;
const MS_PER_SECOND = 1000;
const DEFAULT_LIMIT = 100;

/**
 * Builds an object whose keys are the API's own snake_case names.
 * @param entries Key and value pairs.
 * @returns The object.
 */
function entriesOf(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries);
}

/**
 * Reads a request body.
 * @param req Request.
 * @returns Body text.
 */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Reads the parameters of a request: the query, then the JSON body over it.
 * @param url Request URL.
 * @param body Body text.
 * @returns Parameters by name.
 */
function paramsOf(url: URL, body: string): Record<string, unknown> {
  const params: Record<string, unknown> = Object.fromEntries(url.searchParams);

  if (body !== '') {
    Object.assign(params, JSON.parse(body) as Record<string, unknown>);
  }

  return params;
}

/**
 * Starts a fake Bot API on a random loopback port.
 * @returns The running fake.
 */
export async function startFakeTelegram(): Promise<FakeTelegram> {
  const knobs: FakeTelegramKnobs = {};
  const requests: FakeTelegramRequest[] = [];
  const queue: QueuedUpdate[] = [];
  const wakers = new Set<() => void>();
  const timers = new Set<NodeJS.Timeout>();
  let nextId = FIRST_UPDATE_ID;
  let closed = false;

  const idOf = (update: QueuedUpdate): number => Number(update.update_id);
  const wakeAll = (): void => {
    for (const wake of [...wakers]) {
      wake();
    }
  };
  // Waits for a time, or until a push or the close wakes every waiter.
  const sleep = async (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const handle: TimerHandle = {};
    const wake = (): void => {
      clearTimeout(handle.timer);
      timers.delete(handle.timer as NodeJS.Timeout);
      wakers.delete(wake);
      resolve();
    };

    handle.timer = setTimeout(wake, ms);
    timers.add(handle.timer);
    wakers.add(wake);
  });
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const failure = (res: ServerResponse, status: number): void => {
    const parameters = status === 429 ? { parameters: Object.fromEntries([['retry_after', knobs.retryAfter ?? 1]]) } : {};

    send(res, status, { ok: false,
      description: `fake error ${String(status)}`,
      ...Object.fromEntries([['error_code', status]]),
      ...parameters });
  };

  // A long poll answers when an update is there, or when its time is over.
  const getUpdates = async (params: Record<string, unknown>): Promise<QueuedUpdate[]> => {
    const offset = Number(params.offset ?? 0);
    const limit = Number(params.limit ?? DEFAULT_LIMIT);
    const timeoutS = Number(params.timeout ?? 0);

    if (offset < 0) {
      const last = queue.at(-1);

      queue.splice(0, queue.length - (last === undefined ? 0 : 1));

      return last === undefined ? [] : [last];
    }

    if (offset > 0) {
      queue.splice(0, queue.length, ...queue.filter(update => idOf(update) >= offset));
    }

    if (queue.length === 0 && !closed) {
      await sleep(knobs.holdMs ?? timeoutS * MS_PER_SECOND);
    }

    return queue.slice(0, limit);
  };

  const answer = async (method: FakeTelegramMethod, params: Record<string, unknown>, res: ServerResponse): Promise<void> => {
    if (knobs.rawBody?.[method] !== undefined) {
      res.statusCode = 200;
      res.end(knobs.rawBody[method]);

      return;
    }

    const forced = knobs.status?.[method];

    if (forced !== undefined) {
      failure(res, forced);

      return;
    }

    switch (method) {
      case 'getMe':
        send(res, 200, { ok: true,
          result: { id: BOT_ID,
            username: 'fake_listener_bot',
            ...Object.fromEntries([['is_bot', true], ['can_read_all_group_messages', knobs.privacyOn !== true]]) } });

        return;
      case 'getWebhookInfo':
        send(res, 200, { ok: true,
          result: { url: knobs.webhookUrl ?? '',
            ...Object.fromEntries([['pending_update_count', 0]]) } });

        return;
      case 'getChatMember':
        send(res, 200, { ok: true,
          result: { status: knobs.memberStatus ?? 'administrator',
            user: { id: Number(params.user_id) } } });

        return;
      case 'getUpdates':
        send(res, 200, { ok: true,
          result: await getUpdates(params) });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, bot, method] = url.pathname.split('/');
    const params = paramsOf(url, await readBody(req));

    requests.push({ method: method ?? '',
      params,
      path: url.pathname });

    if (knobs.delayMs !== undefined) {
      await sleep(knobs.delayMs);
    }

    if (bot !== `bot${TOKEN}`) {
      failure(res, 401);

      return;
    }

    if (method === 'getMe' || method === 'getWebhookInfo' || method === 'getChatMember' || method === 'getUpdates') {
      await answer(method, params, res);

      return;
    }

    failure(res, 404);
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    token: TOKEN,
    botId: BOT_ID,
    knobs,
    requests,
    push: (message) => {
      const id = nextId;

      nextId += 1;
      queue.push(entriesOf([['update_id', id],
        ['message', { ...Object.fromEntries([['message_id', id]]),
          date: 1_700_000_000 + id,
          chat: { id: message.chatId ?? DEFAULT_CHAT_ID,
            type: message.chatType ?? 'supergroup' },
          from: { ...Object.fromEntries([['is_bot', message.fromIsBot ?? true]]),
            ...message.fromUsername === undefined ? {} : { username: message.fromUsername } },
          text: message.text }]]));
      wakeAll();

      return id;
    },
    pushOther: () => {
      const id = nextId;

      nextId += 1;
      queue.push(entriesOf([['update_id', id],
        ['edited_channel_post', Object.fromEntries([['message_id', id]])]]));
      wakeAll();

      return id;
    },
    close: async () => new Promise<void>((resolve) => {
      closed = true;
      wakeAll();

      for (const timer of timers) {
        clearTimeout(timer);
      }

      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
