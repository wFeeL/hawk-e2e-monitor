import type { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../config/load.js';
import { scenarioSettings } from '../config/scenario.js';
import type { RouteHandler } from '../http/internal-server.js';
import { sendJson } from '../http/respond.js';
import { HttpStatus } from '../net/http-status.js';
import { SCENARIO_NAMES } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { History } from '../storage/history.js';
import type { Clock } from '../time/clock.js';
import { MS_PER_SECOND } from '../time/units.js';

const RUNS_PREFIX = '/runs/';
const BEARER = /^Bearer (.+)$/iu;

/** What the handler of manual runs needs. */
export interface ManualRunsDeps {
  /** Starts the runs and tells which scenario is busy. */
  scheduler: Pick<Scheduler, 'runNow' | 'status'>;
  /** Store the finished run is read from. */
  history: History;
  /** Configuration with the token, the least time between runs and the watchdog of each scenario. */
  config: Config;
  /** Time source for the pause between runs and the bound of `?wait=true`. */
  clock: Clock;
}

/**
 * Hashes a text so that two texts of any length can be compared in constant time.
 * @param text Text to hash.
 * @returns SHA-256 digest.
 */
function digestOf(text: string): Buffer {
  return createHash('sha256').update(text)
    .digest();
}

/**
 * Reads the token a request presents.
 * @param req Request.
 * @returns The bearer token, or undefined when the header is absent or of another kind.
 */
function bearerOf(req: IncomingMessage): string | undefined {
  return BEARER.exec(req.headers.authorization ?? '')?.[1];
}

/**
 * Finds the scenario a path names.
 * @param pathname Path of the request.
 * @param enabled Scenarios of the configuration.
 * @returns The scenario, or undefined when the name is unknown or the scenario is not enabled.
 */
function scenarioOf(pathname: string, enabled: readonly ScenarioName[]): ScenarioName | undefined {
  let name: string;

  try {
    name = decodeURIComponent(pathname.slice(RUNS_PREFIX.length));
  } catch {
    return undefined;
  }

  return SCENARIO_NAMES.find(known => known === name && enabled.includes(known));
}

/**
 * Builds the handler of `POST /runs/<scenario>`, to be registered only when a token is configured.
 * Order of the answers: 401 without the right bearer token, 404 for an unknown or disabled scenario, 409 when the scenario is busy, 429 when the last manual run is too recent, then 202 with the run id, or 200 with the finished run after `?wait=true`.
 * @param deps Scheduler, history, configuration and clock.
 * @returns Route handler.
 */
export function manualRunHandler(deps: ManualRunsDeps): RouteHandler {
  const { scheduler, history, config, clock } = deps;
  const { token, minIntervalMs } = config.monitoring.manual;
  const expected = token === undefined ? undefined : digestOf(token);
  const startedAt = new Map<ScenarioName, number>();
  const challenge = Object.fromEntries([['www-authenticate', 'Bearer']]);

  const authorized = (req: IncomingMessage): boolean => {
    const presented = bearerOf(req);

    return expected !== undefined && presented !== undefined && timingSafeEqual(digestOf(presented), expected);
  };

  const waitFor = async (scenario: ScenarioName, done: Promise<unknown>): Promise<boolean> => {
    const timer = new AbortController();
    const timeout = clock.sleep(scenarioSettings(config, scenario).watchdogMs, timer.signal).then(() => false, () => false);

    try {
      return await Promise.race([done.then(() => true), timeout]);
    } finally {
      timer.abort();
    }
  };

  return async (req, res) => {
    if (!authorized(req)) {
      sendJson(res, HttpStatus.unauthorized, { error: 'unauthorized' }, challenge);

      return;
    }

    const url = new URL(req.url ?? '/', 'http://internal');
    const scenario = scenarioOf(url.pathname, config.monitoring.scenarios);

    if (scenario === undefined) {
      sendJson(res, HttpStatus.notFound, { error: 'not_found',
        message: `scenario must be one of: ${config.monitoring.scenarios.join(', ')}` });

      return;
    }

    const runningRunId = scheduler.status().find(entry => entry.scenario === scenario)?.runningRunId;

    if (runningRunId !== undefined) {
      sendJson(res, HttpStatus.conflict, { runningRunId });

      return;
    }

    const now = clock.monotonicMs();
    const last = startedAt.get(scenario);

    if (last !== undefined && now - last < minIntervalMs) {
      const retryAfter = Math.ceil((minIntervalMs - (now - last)) / MS_PER_SECOND);

      sendJson(res, HttpStatus.tooManyRequests, { error: 'too_many_requests',
        retryAfterSeconds: retryAfter }, Object.fromEntries([['retry-after', String(retryAfter)]]));

      return;
    }

    const run = scheduler.runNow(scenario, 'manual');

    if (!run.started) {
      sendJson(res, HttpStatus.conflict, { runningRunId: run.runningRunId });

      return;
    }

    startedAt.set(scenario, now);

    if (url.searchParams.get('wait') === 'true' && await waitFor(scenario, run.done)) {
      sendJson(res, HttpStatus.ok, history.get(run.runId) ?? await run.done);

      return;
    }

    sendJson(res, HttpStatus.accepted, { runId: run.runId });
  };
}
