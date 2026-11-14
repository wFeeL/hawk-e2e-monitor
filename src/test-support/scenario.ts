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
import type { ScenarioContext } from '../scenarios/send-and-receive/stages.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { fakeHawkEnv } from './fake-hawk/index.js';
import type { FakeHawk } from './fake-hawk/index.js';
import { expectOk } from './result.js';

const RETRY_DELAYS_MS = [5, 10];
const FAKE_LETTER = 'a';

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

/** What a test may change about the scenario setup. */
export interface TestScenarioOptions {
  /** Run number, 1 by default. */
  sequence?: number;
  /** Forces the transport. */
  transport?: Transport;
  /** Forces the repeat. */
  repeat?: boolean;
  /** Environment variables that replace the defaults. */
  env?: Record<string, string>;
  /** Clock, the system one by default. */
  clock?: Clock;
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
 * Builds clients and a context for a scenario run against a fake Hawk.
 * @param hawk Running fake Hawk.
 * @param options Run number, overrides and clock.
 * @returns Context and its parts.
 */
export function createTestScenario(hawk: FakeHawk, options: TestScenarioOptions = {}): TestScenario {
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
  const plan = planRun(config, { sequence: options.sequence ?? 1,
    transport: options.transport,
    repeat: options.repeat }, count => FAKE_LETTER.repeat(count));

  return {
    context: { config,
      plan,
      collector,
      api,
      clock,
      state: { sendMayHaveReached: false } },
    config,
    plan,
    collector,
    api,
  };
}
