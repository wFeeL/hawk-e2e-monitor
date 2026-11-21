import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunCommand } from '../../src/cli.js';
import type { CheckIo } from '../../src/commands/check.js';
import { runRunCommand } from '../../src/commands/run.js';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/load.js';
import { startEndlessServer } from '../support/endless-server.js';
import type { EndlessServer } from '../support/endless-server.js';
import { validEnv } from '../support/env.js';
import { reservedPort } from '../support/ports.js';
import { createFakeClock } from '../support/fake-clock.js';
import { expectOk } from '../support/result.js';

const TOKEN = 'run-token-0123456789-0123456789-abcdef';
const ALL = 'send-and-receive-event,check-notification,sourcemaps';

/** One request the fake internal server saw. */
interface Seen {
  /** Path and query. */
  path: string;
  /** The `authorization` header. */
  authorization: string | undefined;
}

/** Answer of the fake for one path. */
interface Answer {
  /** HTTP status. */
  status: number;
  /** JSON body. */
  body: unknown;
  /** Pause before the headers go out. */
  delayMs?: number;
  /** Drops the socket instead of answering. */
  destroy?: boolean;
}

/** What the command did. */
interface Outcome {
  /** Exit code. */
  code: number;
  /** Lines of stdout. */
  out: string[];
  /** Lines of stderr. */
  err: string[];
}

/** The fake server's port and its log. */
interface Fake {
  /** Listening port. */
  port: number;
  /** Requests seen so far. */
  seen: Seen[];
}

const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';

let server: Server | undefined;
let endless: EndlessServer | undefined;

afterEach(async () => {
  endless && await endless.close();
  endless = undefined;

  const closing = server;

  server = undefined;

  if (closing) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => {
      closing.close(() => {
        resolve();
      });
    });
  }
});

/**
 * Starts a fake internal server.
 * @param answers Answer by scenario name.
 * @returns Port and the requests seen so far.
 */
async function fake(answers: Record<string, Answer>): Promise<Fake> {
  const seen: Seen[] = [];

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');

    seen.push({ path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization });

    const answer = answers[url.pathname.replace('/runs/', '')] ?? { status: 404,
      body: {} };

    if (answer.destroy === true) {
      req.socket.destroy();

      return;
    }

    setTimeout(() => {
      res.statusCode = answer.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer.body));
    }, answer.delayMs ?? 0);
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', resolve);
  });

  return { port: (server?.address() as AddressInfo).port,
    seen };
}

/**
 * Builds a configuration pointing at the fake.
 * @param port Internal port.
 * @param env Extra variables.
 * @returns Configuration.
 */
function configFor(port: number, env: Record<string, string | undefined> = {}): Config {
  return expectOk(loadConfig(validEnv({ RUN_TOKEN: TOKEN,
    INTERNAL_HOST: '127.0.0.1',
    INTERNAL_PORT: String(port),
    SCENARIOS: ALL,
    RECEIVER_SECRET: 'test-receiver-secret-0123456789a',
    PUBLIC_BASE_URL: 'https://example.com',
    ...env }))).config;
}

/**
 * Runs the command and captures its output.
 * @param scenarios Names from the command line.
 * @param config Configuration.
 * @param deps Test hooks.
 * @returns Exit code and the output lines.
 */
async function run(scenarios: RunCommand['scenarios'], config: Config, deps?: Parameters<typeof runRunCommand>[3]): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CheckIo = { stdout: (text) => {
    out.push(text);
  },
  stderr: (text) => {
    err.push(text);
  } };
  const code = await runRunCommand({ kind: 'run',
    scenarios }, config, io, deps);

  return { code,
    out: out.join('').split('\n')
      .filter(line => line !== ''),
    err: err.join('').split('\n')
      .filter(line => line !== '') };
}

const OK = { status: 'ok',
  durationMs: 4200 };

describe('runRunCommand', () => {
  it('prints ok and failed lines in argument order with the bearer header and exits 1', async () => {
    const { port, seen } = await fake({ sourcemaps: { status: 200,
      body: { status: 'failed',
        failedStage: 'release_saved',
        errorClass: 'hawk_internal',
        message: 'release was not saved' } },
    [NOTIFY]: { status: 200,
      body: OK } });
    const result = await run(['sourcemaps', 'check-notification'], configFor(port));

    expect(seen.map(s => s.path)).toEqual(['/runs/sourcemaps?wait=true', '/runs/check-notification?wait=true']);
    expect(seen.every(s => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.out).toEqual([
      'sourcemaps          failed at release_saved: hawk_internal: release was not saved',
      'check-notification  ok  4.2 s',
    ]);
    expect(result.code).toBe(1);
  });

  it('names the degraded codes of an ok run', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: { status: 'ok',
        durationMs: 6100,
        degraded: ['accept_uncertain', 'quota_usage'],
        result: { warnings: ['w'] } } } });
    const result = await run(['sourcemaps'], configFor(port));

    expect(result.out).toEqual(['sourcemaps  ok  6.1 s  degraded: accept_uncertain, quota_usage  (1 warning)']);
    expect(result.code).toBe(0);
  });

  it('counts the warnings of an ok run without degraded codes', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: { status: 'ok',
        durationMs: 1,
        degraded: [],
        result: { warnings: ['a', 'b'] } } } });
    const result = await run(['sourcemaps'], configFor(port));

    expect(result.out[0]).toContain('(2 warnings)');
    expect(result.out[0]).not.toContain('degraded:');
    expect(result.code).toBe(0);
  });

  it('names degraded codes without warnings', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: { status: 'ok',
        durationMs: 1,
        degraded: ['quota_usage'],
        result: { warnings: [] } } } });
    const result = await run(['sourcemaps'], configFor(port));

    expect(result.out[0]).toContain('degraded: quota_usage');
    expect(result.out[0]).not.toContain('warning');
    expect(result.code).toBe(0);
  });

  it('prints not started for 503', async () => {
    const { port } = await fake({ sourcemaps: { status: 503,
      body: { error: 'stopping' } } });
    const result = await run(['sourcemaps'], configFor(port));

    expect(result.out).toEqual(['sourcemaps  not started: the service is stopping']);
    expect(result.code).toBe(1);
  });

  it('without names asks every enabled scenario in config order and exits 0 when all are ok', async () => {
    const { port, seen } = await fake({ [SEND]: { status: 200,
      body: OK },
    [NOTIFY]: { status: 200,
      body: OK },
    sourcemaps: { status: 200,
      body: { status: 'ok' } } });
    const result = await run([], configFor(port));

    expect(seen.map(s => s.path)).toEqual([
      '/runs/send-and-receive-event?wait=true',
      '/runs/check-notification?wait=true',
      '/runs/sourcemaps?wait=true',
    ]);
    expect(result.out[2]).toBe('sourcemaps              ok');
    expect(result.code).toBe(0);
  });

  it('prints the lines of 429, 409, 202, 404 and an unknown status', async () => {
    const { port } = await fake({ [SEND]: { status: 429,
      body: { retryAfterSeconds: 42 } },
    [NOTIFY]: { status: 409,
      body: { runningRunId: 'abc' } },
    sourcemaps: { status: 202,
      body: { runId: 'run1' } } });
    const result = await run([], configFor(port));

    expect(result.out).toEqual([
      'send-and-receive-event  skipped: manual run limit, retry in 42 s',
      'check-notification      skipped: already running (abc)',
      'sourcemaps              started (run1), still running; see history',
    ]);
    expect(result.code).toBe(1);

    const other = await run(['sourcemaps'], configFor(port, { SCENARIOS: 'sourcemaps' }));

    expect(other.out).toEqual(['sourcemaps  started (run1), still running; see history']);
  });

  it('prints not enabled for 404, a bare status for skipped and unexpected HTTP for others', async () => {
    const { port } = await fake({ [SEND]: { status: 404,
      body: {} },
    [NOTIFY]: { status: 200,
      body: { status: 'skipped' } },
    sourcemaps: { status: 500,
      body: {} } });
    const result = await run([], configFor(port));

    expect(result.out).toEqual([
      'send-and-receive-event  not enabled in SCENARIOS',
      'check-notification      skipped',
      'sourcemaps              unexpected HTTP 500',
    ]);
    expect(result.code).toBe(1);
  });

  it('stops on 401 with one error line and exit 2', async () => {
    const { port, seen } = await fake({ [SEND]: { status: 401,
      body: {} } });
    const result = await run([], configFor(port));

    expect(result.err).toEqual(['the service rejected RUN_TOKEN; is it the same as the one serve was started with?']);
    expect(result.out).toEqual([]);
    expect(result.code).toBe(2);
    expect(seen).toHaveLength(1);
  });

  it('says serve is not running when the port refuses', async () => {
    const port = await reservedPort();
    const result = await run([], configFor(port));

    expect(result.err).toEqual([`serve is not running on 127.0.0.1:${String(port)}`]);
    expect(result.code).toBe(2);
  });

  it('exits 2 without a request when RUN_TOKEN is not set', async () => {
    const { port, seen } = await fake({});
    const result = await run([], configFor(port, { RUN_TOKEN: undefined }));

    expect(result.err).toEqual(['RUN_TOKEN is not set, so the service takes no manual runs']);
    expect(result.code).toBe(2);
    expect(seen).toEqual([]);
  });

  it('exits 2 without a request when a named scenario is not enabled', async () => {
    const { port, seen } = await fake({});
    const result = await run(['sentry-envelope'], configFor(port));

    expect(result.err).toEqual(['sentry-envelope is not enabled in SCENARIOS']);
    expect(result.code).toBe(2);
    expect(seen).toEqual([]);
  });

  it('asks 127.0.0.1 when the service listens on 0.0.0.0', async () => {
    const { port, seen } = await fake({ sourcemaps: { status: 200,
      body: OK } });
    const result = await run(['sourcemaps'], configFor(port, { INTERNAL_HOST: '0.0.0.0' }));

    expect(seen).toHaveLength(1);
    expect(result.code).toBe(0);
  });

  it('reports no answer: TIMEOUT when the clock passes the deadline', async () => {
    endless = await startEndlessServer();

    const clock = createFakeClock();
    const port = Number(new URL(endless.url).port);
    const pending = run(['sourcemaps'], configFor(port), { requestTimeoutMs: () => 200,
      clock });

    await vi.waitFor(() => {
      expect(clock.pending()).toBe(1);
    });
    await clock.advance(200);

    const result = await pending;

    expect(result.out).toEqual(['sourcemaps  no answer: TIMEOUT']);
    expect(result.code).toBe(1);
  });

  it('leaves no timer after a full answer', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: OK } });
    const clock = createFakeClock();
    const result = await run(['sourcemaps'], configFor(port), { clock });

    expect(result.code).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it('leaves no timer after an answer that breaks off', async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', '100');
      res.statusCode = 200;
      res.write('{"status":', () => {
        req.socket.destroy();
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });

    const clock = createFakeClock();
    const result = await run(['sourcemaps'], configFor((server.address() as AddressInfo).port), { clock });

    expect(result.code).toBe(2);
    expect(result.err[0]).toMatch(/^cannot reach serve on /u);
    expect(clock.pending()).toBe(0);
  });

  it('waits for headers that come late, with no timeout of its own besides the request one', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: OK,
      delayMs: 400 } });
    const result = await run(['sourcemaps'], configFor(port), { requestTimeoutMs: () => 2000 });

    expect(result.out).toEqual(['sourcemaps  ok  4.2 s']);
    expect(result.code).toBe(0);
  });

  it('stops with exit 2 and the code when the socket is dropped before an answer', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: OK,
      destroy: true } });
    const result = await run(['sourcemaps', 'check-notification'], configFor(port));

    expect(result.err).toEqual([`cannot reach serve on 127.0.0.1:${String(port)}: ECONNRESET`]);
    expect(result.out).toEqual([]);
    expect(result.code).toBe(2);
  });

  it('names the reason of a skipped run: the skip reason first, else the first warning', async () => {
    const { port } = await fake({ [SEND]: { status: 200,
      body: { status: 'skipped',
        skipReason: 'rule_cache_warmup',
        result: { warnings: ['ignored'] } } },
    [NOTIFY]: { status: 200,
      body: { status: 'skipped',
        result: { warnings: [],
          stages: [{ details: {} }, { details: { warning: 'rule cache is warming up' } }] } } },
    sourcemaps: { status: 200,
      body: { status: 'skipped',
        result: { warnings: ['first', 'second'] } } } });
    const result = await run([], configFor(port));

    expect(result.out).toEqual([
      'send-and-receive-event  skipped: rule_cache_warmup',
      'check-notification      skipped: rule cache is warming up',
      'sourcemaps              skipped: first',
    ]);
    expect(result.code).toBe(1);
  });

  it('names the class and the message of an aborted run', async () => {
    const { port } = await fake({ sourcemaps: { status: 200,
      body: { status: 'aborted',
        errorClass: 'run_timeout',
        message: 'the run took too long' } } });
    const result = await run(['sourcemaps'], configFor(port));

    expect(result.out).toEqual(['sourcemaps  aborted: run_timeout: the run took too long']);
  });
});
