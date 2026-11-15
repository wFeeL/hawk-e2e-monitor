import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from '../log/logger.js';
import { sendJson } from './respond.js';
import { HttpStatus } from '../net/http-status.js';

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
  /** Extra routes keyed by `${method} ${pathname}`, e.g. `POST /runs`; a key that ends in `/*` serves every path below that prefix. */
  routes?: ReadonlyMap<string, RouteHandler>;
}

/** Why a check failed. */
export interface CheckFailure {
  /** Name of the failed check. */
  name: string;
  /** `false` for a negative result, `threw` for an exception, `timeout` for a missed deadline. */
  reason: 'false' | 'threw' | 'timeout';
  /** The thrown value; present only when `reason` is `threw`. */
  error?: unknown;
}

/**
 * Runs one check; a throw, `false` or a timeout counts as a failure.
 * @param check Probe to execute.
 * @param timeoutMs Time limit before the probe is aborted.
 * @returns The failure, or undefined when the check passed in time.
 */
async function runCheck(check: Check, timeoutMs: number): Promise<CheckFailure | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckFailure>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ name: check.name,
        reason: 'timeout' });
    }, timeoutMs);
  });
  const outcome = (async (): Promise<CheckFailure | undefined> => {
    try {
      if (await check.run(controller.signal)) {
        return undefined;
      }

      return { name: check.name,
        reason: 'false' };
    } catch (error: unknown) {
      return { name: check.name,
        reason: 'threw',
        error };
    }
  })();

  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs all checks in parallel.
 * @param checks Checks to run.
 * @param timeoutMs Time limit for each check.
 * @returns Failed checks with reasons, in the order of `checks`.
 */
export async function evaluateChecks(checks: readonly Check[], timeoutMs: number): Promise<CheckFailure[]> {
  const results = await Promise.all(checks.map(async check => runCheck(check, timeoutMs)));

  return results.filter(result => result !== undefined);
}

/**
 * Extracts the path of a request target, dropping the query string.
 * @param target Raw `req.url`.
 * @returns Pathname, or undefined when the target cannot be parsed.
 */
function parsePathname(target: string | undefined): string | undefined {
  try {
    return new URL(target ?? '/', 'http://internal').pathname;
  } catch {
    return undefined;
  }
}

/**
 * Finds the handler of a request: an exact `METHOD /path` key first, then the longest `METHOD /prefix/*` key.
 * @param routes Registered routes.
 * @param method HTTP method.
 * @param pathname Path of the request without the query.
 * @returns The handler, or undefined.
 */
function findRoute(routes: ReadonlyMap<string, RouteHandler> | undefined, method: string, pathname: string): RouteHandler | undefined {
  const exact = routes?.get(`${method} ${pathname}`);

  if (exact !== undefined || routes === undefined) {
    return exact;
  }

  const prefixes = [...routes.keys()]
    .filter(key => key.startsWith(`${method} /`) && key.endsWith('/*') && pathname.startsWith(key.slice(method.length + 1, -1)))
    .toSorted((left, right) => right.length - left.length);

  return prefixes[0] === undefined ? undefined : routes.get(prefixes[0]);
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
    const pathname = parsePathname(req.url);

    if (pathname === undefined) {
      throw new Error('Request target cannot be parsed');
    }

    const method = req.method ?? '';
    const checks = probes.get(pathname);

    if (checks && method === 'GET') {
      const failures = await evaluateChecks(checks, options.checkTimeoutMs);

      for (const failure of failures) {
        options.logger.warn('check failed', {
          probe: pathname.slice(1),
          check: failure.name,
          reason: failure.reason,
          ...failure.reason === 'threw' ? { error: failure.error } : {},
        });
      }
      if (failures.length === 0) {
        sendJson(res, HttpStatus.ok, { status: 'ok' });
      } else {
        sendJson(res, HttpStatus.serviceUnavailable, { status: 'fail',
          failed: failures.map(failure => failure.name) });
      }

      return;
    }

    const route = findRoute(options.routes, method, pathname);

    if (route) {
      await route(req, res);
    } else if (checks) {
      sendJson(res, HttpStatus.methodNotAllowed, { error: 'method_not_allowed' }, { allow: 'GET' });
    } else {
      sendJson(res, HttpStatus.notFound, { error: 'not_found' });
    }
  };

  return createServer((req, res) => {
    // The target is parsed inside `handle` so a malformed one becomes a rejection, not an uncaught exception.
    handle(req, res).catch((error: unknown) => {
      options.logger.error('internal request failed', {
        error,
        method: req.method,
        path: parsePathname(req.url) ?? '(unparsable)',
      });
      if (res.headersSent) {
        res.destroy();
      } else {
        sendJson(res, HttpStatus.internalServerError, { error: 'internal_error' });
      }
    });
  });
}
