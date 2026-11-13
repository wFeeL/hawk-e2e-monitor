import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from '../log/logger.js';

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_UNAVAILABLE = 503;
const HEALTH_PATH = '/healthz';
const READY_PATH = '/readyz';

/** A named probe behind `/healthz` or `/readyz`. */
export interface Check {
  /** Name reported when the check fails. */
  name: string;
  /** Resolves true when healthy; the signal aborts when the time limit passes. */
  run: (signal: AbortSignal) => Promise<boolean>;
}

/** Handler of an extra route. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/** Settings of `createInternalServer`. */
export interface InternalServerOptions {
  /** Receives request failures. */
  logger: Logger;
  /** Checks behind `/healthz`. */
  liveness: readonly Check[];
  /** Checks behind `/readyz`. */
  readiness: readonly Check[];
  /** Time limit for one check. */
  checkTimeoutMs: number;
  /** Extra routes keyed by `${method} ${pathname}`, e.g. `POST /runs`. */
  routes?: ReadonlyMap<string, RouteHandler>;
}

/**
 * Runs one check; a throw, `false` or a timeout counts as a failure.
 * @param check Probe to execute.
 * @param timeoutMs Time limit before the probe is aborted.
 * @returns True when the check passed in time.
 */
async function runCheck(check: Check, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(false);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      (async (): Promise<boolean> => check.run(controller.signal))().catch(() => false),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs all checks in parallel.
 * @param checks Checks to run.
 * @param timeoutMs Time limit for each check.
 * @returns Names of failed checks in the order of `checks`.
 */
export async function evaluateChecks(checks: readonly Check[], timeoutMs: number): Promise<string[]> {
  const results = await Promise.all(checks.map(async check => runCheck(check, timeoutMs)));

  return checks.filter((_check, index) => results[index] !== true).map(check => check.name);
}

/**
 * Sends a JSON response with the headers every internal reply carries.
 * @param res Response to write.
 * @param status HTTP status.
 * @param body Value serialized as the body.
 * @param headers Extra headers.
 */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/**
 * Creates the internal HTTP server; the caller starts and stops it.
 * @param options Checks, routes, logger and the check time limit.
 * @returns Server that is not listening yet.
 */
export function createInternalServer(options: InternalServerOptions): Server {
  const probes = new Map<string, readonly Check[]>([
    [HEALTH_PATH, options.liveness],
    [READY_PATH, options.readiness],
  ]);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://internal');
    const method = req.method ?? '';
    const checks = probes.get(pathname);

    if (checks && method === 'GET') {
      const failed = await evaluateChecks(checks, options.checkTimeoutMs);

      if (failed.length === 0) {
        sendJson(res, HTTP_OK, { status: 'ok' });
      } else {
        sendJson(res, HTTP_UNAVAILABLE, { status: 'fail',
          failed });
      }

      return;
    }

    const route = options.routes?.get(`${method} ${pathname}`);

    if (route) {
      await route(req, res);
    } else if (checks) {
      sendJson(res, HTTP_METHOD_NOT_ALLOWED, { error: 'method_not_allowed' }, { allow: 'GET' });
    } else {
      sendJson(res, HTTP_NOT_FOUND, { error: 'not_found' });
    }
  };

  return createServer((req, res) => {
    // The target is parsed inside `handle` so a malformed one becomes a rejection, not an uncaught exception.
    handle(req, res).catch((error: unknown) => {
      options.logger.error('internal request failed', {
        error,
        method: req.method,
        path: req.url,
      });
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, HTTP_INTERNAL_ERROR, { error: 'internal_error' });
      }
    });
  });
}
