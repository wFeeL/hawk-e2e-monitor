import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeTelegram } from './fake-telegram.js';

const TOKEN_BYTES = 8;
const MARKDOWN_ESCAPE = /\\([_*`[])/gu;

/** Switches a test sets to break the fake service. */
export interface FakeCodexNotifyKnobs {
  /** Answers every POST with this status and sends nothing to the chat. */
  status?: number;
  /** Answers 200 and `OK!` but never sends the message to the chat. */
  drop?: boolean;
}

/** One POST the fake service received. */
export interface FakeCodexRequest {
  /** Path of the request. */
  path: string;
  /** Decoded form fields. */
  form: Record<string, string>;
}

/** Options of the fake service. */
export interface FakeCodexNotifyOptions {
  /** Fake Telegram that receives the messages the service sends. */
  telegram: FakeTelegram;
  /** Username the messages come from, `codex_bot` by default. */
  username?: string;
  /** Id of the chat the service posts to, the fake's default chat when absent. */
  chatId?: number;
}

/** Running fake of @codex_bot's notify service: a POST becomes a message from the bot in the fake chat. */
export interface FakeCodexNotify {
  /** `http://127.0.0.1:<port>/u/<token>`. */
  readonly url: string;
  /** `http://127.0.0.1:<port>`, the part a rewrite of `https://notify.bot.codex.so` replaces. */
  readonly base: string;
  /** The token of the known chat. */
  readonly token: string;
  /** Mutable switches. */
  readonly knobs: FakeCodexNotifyKnobs;
  /** Requests in arrival order. */
  readonly requests: FakeCodexRequest[];
  /**
   * Sends a text into the chat as the bot does, with the Markdown parse mode applied when asked.
   * @param text Text of the POST.
   * @param parseMode `Markdown` removes the escapes the way Telegram renders them; anything else keeps the text.
   */
  deliver(text: string, parseMode?: string): void;
  /**
   * Stops the server and drops connections.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
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
 * Starts a fake notify service on a random loopback port.
 * @param options The fake Telegram it posts into.
 * @returns The running fake.
 */
export async function startFakeCodexNotify(options: FakeCodexNotifyOptions): Promise<FakeCodexNotify> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const knobs: FakeCodexNotifyKnobs = {};
  const requests: FakeCodexRequest[] = [];

  const deliver: FakeCodexNotify['deliver'] = (text, parseMode) => {
    options.telegram.push({ fromUsername: options.username ?? 'codex_bot',
      fromIsBot: true,
      text: parseMode === 'Markdown' ? text.replaceAll(MARKDOWN_ESCAPE, '$1') : text,
      ...options.chatId === undefined ? {} : { chatId: options.chatId } });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    const path = req.url ?? '';

    requests.push({ path,
      form });

    if (knobs.status !== undefined) {
      res.statusCode = knobs.status;
      res.end('fake failure');

      return;
    }

    if (req.method !== 'POST' || path !== `/u/${token}`) {
      res.statusCode = 404;
      res.end('Not found');

      return;
    }

    if (knobs.drop !== true) {
      deliver(form.message ?? '', form.parse_mode);
    }

    res.statusCode = 200;
    res.end('OK!');
  };
  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    url: `${base}/u/${token}`,
    base,
    token,
    knobs,
    requests,
    deliver,
    close: async () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
