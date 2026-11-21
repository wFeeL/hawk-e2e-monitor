import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

const TOKEN_BYTES = 8;

/** What the fake bot answers. */
export interface FakeNotifyAnswer {
  /** HTTP status, 200 by default. */
  status?: number;
  /** Body, `OK!` by default. */
  body?: string;
  /** Time the answer is held back; a held answer is dropped when the bot closes. */
  delayMs?: number;
  /** Answers a message differently from the rest; returns undefined to use the fields above. */
  answerFor?: (message: string) => FakeNotifyAnswer | undefined;
}

/** One POST the fake bot received. */
export interface FakeNotifyRequest {
  /** Path of the request. */
  path: string;
  /** `content-type` header. */
  contentType: string;
  /** Decoded form fields. */
  form: Record<string, string>;
}

/** Running fake of the codex.bot notify endpoint. */
export interface FakeNotify {
  /** `http://127.0.0.1:<port>/u/<token>`. */
  readonly url: string;
  /** Token part of the path, to check that it does not leak. */
  readonly token: string;
  /** Requests in arrival order. */
  readonly requests: FakeNotifyRequest[];
  /**
   * Changes the answer of later requests.
   * @param answer New answer; omitted fields fall back to 200 and `OK!`.
   */
  setAnswer(answer: FakeNotifyAnswer): void;
  /**
   * Stops the server, drops connections and cancels held answers.
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
 * Starts a fake codex.bot notify endpoint on a random loopback port.
 * @param initial First answer.
 * @returns Running fake.
 */
export async function startFakeNotify(initial: FakeNotifyAnswer = {}): Promise<FakeNotify> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const requests: FakeNotifyRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let answer = initial;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);

    requests.push({ path: req.url ?? '',
      contentType: req.headers['content-type'] ?? '',
      form: Object.fromEntries(new URLSearchParams(body)) });

    const given = answer.answerFor?.(requests.at(-1)?.form.message ?? '') ?? answer;
    const reply = (): void => {
      res.statusCode = given.status ?? 200;
      res.end(given.body ?? 'OK!');
    };

    if (given.delayMs === undefined) {
      reply();
    } else {
      timers.add(setTimeout(reply, given.delayMs));
    }
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
    url: `http://127.0.0.1:${String(port)}/u/${token}`,
    token,
    requests,
    setAnswer: (next) => {
      answer = next;
    },
    close: async () => new Promise<void>((resolve) => {
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
