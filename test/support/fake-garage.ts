import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the fake answers on one path. */
export interface FakeGarageAnswer {
  /** HTTP status, 200 by default. */
  status?: number;
  /** `content-type` header; none when absent. */
  contentType?: string;
  /** Body text. */
  body?: string;
}

/** One request the fake received. */
export interface FakeGarageRequest {
  /** Path of the request. */
  path: string;
  /** `range` header, empty when absent. */
  range: string;
}

/** Running fake of Garage, the web front end of Hawk. */
export interface FakeGarage {
  /** `http://127.0.0.1:<port>`, an origin without a trailing slash. */
  readonly origin: string;
  /** Requests in arrival order. */
  readonly requests: FakeGarageRequest[];
  /**
   * Sets the answer for a path.
   * @param path Path such as `/` or `/assets/index.js`.
   * @param answer What to send.
   */
  answer(path: string, answer: FakeGarageAnswer): void;
  /**
   * Makes the fake ignore the `Range` header, as a server without range support does.
   * @param ignore True to answer the whole body with 200.
   */
  ignoreRange(ignore: boolean): void;
  /**
   * Stops the server and drops its connections.
   * @returns Resolves when the port is released.
   */
  close(): Promise<void>;
}

export const BUNDLE_PATH = '/assets/index-1a2b3c.js';
const INDEX_HTML = `<!doctype html><html><head><script type="module" crossorigin src="${BUNDLE_PATH}"></script></head><body><div id="app"></div></body></html>`;
const BUNDLE_JS = `const answer = 42;\n${'// padding\n'.repeat(500)}`;
const RANGE_PATTERN = /^bytes=(\d+)-(\d+)$/u;

/**
 * Starts a fake Garage: an index page with a module script and the script itself.
 * Like the real one, which runs `http-server --push-state`, it serves the index page for any other path.
 * @returns Running fake with the defaults of a healthy Garage.
 */
export async function startFakeGarage(): Promise<FakeGarage> {
  const requests: FakeGarageRequest[] = [];
  const answers = new Map<string, FakeGarageAnswer>([
    ['/', { contentType: 'text/html; charset=utf-8',
      body: INDEX_HTML }],
    [BUNDLE_PATH, { contentType: 'text/javascript; charset=utf-8',
      body: BUNDLE_JS }],
  ]);
  let ignoringRange = false;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = req.url ?? '/';
    const range = req.headers.range ?? '';

    requests.push({ path,
      range });

    const found = answers.get(path) ?? answers.get('/') ?? {};
    let body = found.body ?? '';
    let status = found.status ?? 200;
    const bytes = RANGE_PATTERN.exec(range);

    if (bytes !== null && !ignoringRange && status === 200) {
      body = Buffer.from(body).subarray(Number(bytes[1]), Number(bytes[2]) + 1)
        .toString();
      status = 206;
    }

    if (found.contentType !== undefined) {
      res.setHeader('content-type', found.contentType);
    }

    res.statusCode = status;
    res.end(body);
  };
  const server: Server = createServer(handle);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    answer: (path, answer) => {
      answers.set(path, answer);
    },
    ignoreRange: (ignore) => {
      ignoringRange = ignore;
    },
    close: async () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
