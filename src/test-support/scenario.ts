import { createCollectorClient } from '../clients/collector.js';
import type { CollectorClient, Transport } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/load.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import { planRun } from '../scenarios/send-and-receive/plan.js';
import type { RunPlan } from '../scenarios/send-and-receive/plan.js';
import { createScenarioRedactor } from '../scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../scenarios/send-and-receive/run.js';
import type { ScenarioContext } from '../scenarios/send-and-receive/stages.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { memoryLogger } from './logger.js';
import type { MemoryLogger } from './logger.js';
import { fakeHawkEnv } from './fake-hawk/index.js';
import type { FakeHawk } from './fake-hawk/index.js';
import { expectOk } from './result.js';

const RETRY_DELAYS_MS = [5, 10];
const FAKE_LETTER = 'a';
const POLL_SCHEDULE_MS = [20, 40];

/** Short limits so tests never wait long; `HTTP_TIMEOUT_MS` stays below every budget. */
const SHORT_LIMITS: Record<string, string> = {
  HTTP_TIMEOUT_MS: '100',
  COLLECTOR_AVAILABILITY_TIMEOUT_MS: '400',
  API_AVAILABILITY_TIMEOUT_MS: '400',
  COLLECTOR_ACCEPT_TIMEOUT_MS: '400',
  EVENT_VISIBLE_TIMEOUT_MS: '400',
  EVENT_REPEATED_TIMEOUT_MS: '400',
  CLEANUP_TIMEOUT_MS: '400',
  RUN_TIMEOUT_MS: '5000',
};

/** What a test may change about the setup. */
export interface TestDepsOptions {
  /** Environment variables that replace the defaults. */
  env?: Record<string, string>;
  /** Clock, the system one by default. */
  clock?: Clock;
}

/** Dependencies of a scenario run on a fake Hawk. */
export interface TestDeps {
  /** Dependencies to pass to `runSendAndReceive`. */
  deps: ScenarioDeps;
  /** Logger kept inside `deps`. */
  logger: MemoryLogger;
}

/**
 * Builds the dependencies of a scenario run against a fake Hawk: short limits, short retry delays, a poll schedule of 20 and 40 ms.
 * @param hawk Running fake Hawk.
 * @param options Environment overrides and clock.
 * @returns Dependencies and the memory logger inside them.
 */
export function createTestDeps(hawk: FakeHawk, options: TestDepsOptions = {}): TestDeps {
  const clock = options.clock ?? systemClock;
  const config = expectOk(loadConfig({ ...fakeHawkEnv(hawk),
    ...SHORT_LIMITS,
    ...options.env })).config;
  const token = decodeIntegrationToken(config.hawk.integrationToken);

  if (token === undefined) {
    throw new Error('Test token does not decode');
  }

  const collector = createCollectorClient({ endpoints: collectorEndpoints(token, config.hawk.collectorUrl),
    httpTimeoutMs: config.httpTimeoutMs,
    clock,
    retryDelaysMs: RETRY_DELAYS_MS });
  const api = createHawkApi({
    transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retryDelaysMs: RETRY_DELAYS_MS }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock,
    retryDelaysMs: RETRY_DELAYS_MS,
  });
  const logger = memoryLogger();

  return {
    logger,
    deps: { config,
      collector,
      api,
      clock,
      logger,
      redact: createScenarioRedactor(config),
      randomLetters: count => FAKE_LETTER.repeat(count),
      pollScheduleMs: POLL_SCHEDULE_MS },
  };
}

/** What a test may change about the scenario context. */
export interface TestScenarioOptions extends TestDepsOptions {
  /** Run number, 1 by default. */
  sequence?: number;
  /** Forces the transport. */
  transport?: Transport;
  /** Forces the repeat. */
  repeat?: boolean;
}

/** A scenario context on a fake Hawk, with its parts exposed. */
export interface TestScenario {
  /** Context to pass to stages. */
  context: ScenarioContext;
  /** Configuration the clients were built from. */
  config: Config;
  /** Plan of the run. */
  plan: RunPlan;
  /** Collector client with short retry delays. */
  collector: CollectorClient;
  /** API client with short retry delays. */
  api: HawkApi;
}

/**
 * Builds clients and a context for stages run one by one against a fake Hawk.
 * @param hawk Running fake Hawk.
 * @param options Run number, overrides and clock.
 * @returns Context and its parts.
 */
export function createTestScenario(hawk: FakeHawk, options: TestScenarioOptions = {}): TestScenario {
  const { deps } = createTestDeps(hawk, options);
  const { config, collector, api, clock } = deps;
  const plan = planRun(config, { sequence: options.sequence ?? 1,
    transport: options.transport,
    repeat: options.repeat }, deps.randomLetters);

  return {
    context: { config,
      plan,
      collector,
      api,
      clock,
      pollScheduleMs: deps.pollScheduleMs,
      state: { sendMayHaveReached: false } },
    config,
    plan,
    collector,
    api,
  };
}
