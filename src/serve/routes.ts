import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Alerter } from '../alerting/alerter.js';
import type { Config } from '../config/load.js';
import type { RouteHandler } from '../http/internal-server.js';
import { SCENARIO_NAMES } from '../scenarios/send-and-receive/plan.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { History, ListOptions } from '../storage/history.js';
import type { Clock } from '../time/clock.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;
const RUNS_PREFIX = '/runs/';

/** What the routes read. */
export interface RouteDeps {
  /** History to read. */
  history: History;
  /** Configuration, for the scenarios of `/stats`. */
  config: Config;
  /** Time source for the windows of `/stats`. */
  clock: Clock;
  /** Scheduler, for its count of failed writes. */
  scheduler: Scheduler;
  /** Alerter, for its backlog and its count of failed writes. */
  alerter: Alerter;
  /** Counts failed sweeps of leftover events. */
  sweepFailures: () => number;
}

/**
 * Answers with JSON that must not be cached.
 * @param res Response.
 * @param status HTTP status.
 * @param body Value to serialize.
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

/**
 * Answers 400 with a text that says what is wrong.
 * @param res Response.
 * @param message What is wrong with the request.
 */
function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, HTTP_BAD_REQUEST, { error: 'bad_request',
    message });
}

/**
 * Reads the query of a request.
 * @param req Request.
 * @returns The search parameters.
 */
function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://internal').searchParams;
}

/**
 * Handles `GET /runs?scenario=&limit=`.
 * @param deps What the routes read.
 * @returns Route handler.
 */
function listRuns(deps: RouteDeps): RouteHandler {
  return (req, res) => {
    const query = queryOf(req);
    const scenarioText = query.get('scenario');
    const limitText = query.get('limit');
    const scenario = SCENARIO_NAMES.find(name => name === scenarioText);

    if (scenarioText !== null && scenario === undefined) {
      badRequest(res, `scenario must be one of: ${SCENARIO_NAMES.join(', ')}`);

      return;
    }

    const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);

    if (limitText !== null && (!/^\d+$/u.test(limitText) || limit < 1 || limit > MAX_LIMIT)) {
      badRequest(res, `limit must be a whole number from 1 to ${String(MAX_LIMIT)}`);

      return;
    }

    const options: ListOptions = { limit };

    if (scenario !== undefined) {
      options.scenario = scenario;
    }

    sendJson(res, HTTP_OK, deps.history.list(options));
  };
}

/**
 * Handles `GET /runs/<runId>`.
 * @param deps What the routes read.
 * @returns Route handler.
 */
function oneRun(deps: RouteDeps): RouteHandler {
  return (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname;
    const runId = decodeURIComponent(pathname.slice(RUNS_PREFIX.length));
    const run = runId === '' ? undefined : deps.history.get(runId);

    if (run === undefined) {
      sendJson(res, HTTP_NOT_FOUND, { error: 'not_found' });

      return;
    }

    sendJson(res, HTTP_OK, run);
  };
}

/**
 * Handles `GET /stats`.
 * @param deps What the routes read.
 * @returns Route handler.
 */
function stats(deps: RouteDeps): RouteHandler {
  return (_req, res) => {
    const now = deps.clock.wallTime();
    const alerts = deps.alerter.health();

    sendJson(res, HTTP_OK, {
      generatedAt: now.toISOString(),
      scenarios: deps.history.stats(now, deps.config.monitoring.scenarios),
      storageFailures: deps.scheduler.failures() + deps.alerter.failures(),
      sweepFailures: deps.sweepFailures(),
      alertBacklogAgeMs: alerts.backlogAgeMs,
      alertRejected: alerts.rejectedInRow,
    });
  };
}

/**
 * Builds the routes of the internal server: `/runs`, `/runs/<runId>` and `/stats`, all `GET`.
 * @param deps What the routes read.
 * @returns Routes for `createInternalServer`.
 */
export function createRoutes(deps: RouteDeps): Map<string, RouteHandler> {
  return new Map<string, RouteHandler>([
    ['GET /runs', listRuns(deps)],
    ['GET /runs/*', oneRun(deps)],
    ['GET /stats', stats(deps)],
  ]);
}
