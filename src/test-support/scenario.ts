import { createCollectorClient } from '../clients/collector.js';
import type { CollectorClient, Transport } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import { loadConfig, notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import { createProvisioner } from '../notifications/provisioning.js';
import type { Provisioner } from '../notifications/provisioning.js';
import type { PublicAddress } from '../notifications/address.js';
import { startReceiver } from '../receiver/server.js';
import type { Receiver } from '../receiver/server.js';
import type { NotificationContext } from '../scenarios/check-notification/stages.js';
import { planRun } from '../scenarios/send-and-receive/plan.js';
import type { RunPlan } from '../scenarios/send-and-receive/plan.js';
import { createMutableRedactor } from '../errors/redact.js';
import type { NotificationDeps } from '../scenarios/check-notification/run.js';
import { createScenarioRedactor, scenarioSecrets } from '../scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../scenarios/send-and-receive/run.js';
import type { ScenarioContext } from '../scenarios/send-and-receive/stages.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { memoryLogger } from './logger.js';
import type { MemoryLogger } from './logger.js';
import { httpAddress } from './address.js';
import { TEST_RECEIVER_SECRET } from './env.js';
import { fakeHawkEnv } from './fake-hawk/index.js';
import type { FakeHawk } from './fake-hawk/index.js';
import { expectOk } from './result.js';

const FAKE_LETTER = 'a';
const POLL_SCHEDULE_MS = [20, 40];
const PRE_PROVISION_TIMEOUT_MS = 5000;

/** Limits for healthy-path tests: far above what a loaded CI machine needs, so a slow start never fails a run. `HTTP_TIMEOUT_MS` stays below every timeout. */
const SHORT_LIMITS: Record<string, string> = {
  HTTP_TIMEOUT_MS: '1000',
  COLLECTOR_AVAILABILITY_TIMEOUT_MS: '2000',
  API_AVAILABILITY_TIMEOUT_MS: '2000',
  COLLECTOR_ACCEPT_TIMEOUT_MS: '2000',
  EVENT_VISIBLE_TIMEOUT_MS: '2000',
  EVENT_REPEATED_TIMEOUT_MS: '2000',
  CLEANUP_TIMEOUT_MS: '5000',
  LATE_DUPLICATE_WAIT_MS: '10',
  RUN_TIMEOUT_MS: '20000',
  NOTIFICATION_TIMEOUT_MS: '2000',
  NOTIFICATION_PAIR_WAIT_MS: '500',
  NOTIFICATION_SETUP_TIMEOUT_MS: '2000',
  RETRY_DELAYS_MS: '5,10',
};

/** Tight limits for tests that make a timeout happen on purpose (delays of 300 ms and more). */
export const TIMEOUT_LIMITS: Record<string, string> = {
  HTTP_TIMEOUT_MS: '100',
  COLLECTOR_AVAILABILITY_TIMEOUT_MS: '400',
  API_AVAILABILITY_TIMEOUT_MS: '400',
  COLLECTOR_ACCEPT_TIMEOUT_MS: '400',
  EVENT_VISIBLE_TIMEOUT_MS: '400',
  EVENT_REPEATED_TIMEOUT_MS: '400',
  CLEANUP_TIMEOUT_MS: '600',
  LATE_DUPLICATE_WAIT_MS: '10',
  RUN_TIMEOUT_MS: '5000',
  NOTIFICATION_TIMEOUT_MS: '400',
  NOTIFICATION_PAIR_WAIT_MS: '100',
  NOTIFICATION_SETUP_TIMEOUT_MS: '400',
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
    retry: config.retry });
  const api = createHawkApi({
    transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retry: config.retry }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock,
    retry: config.retry,
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
    repeat: options.repeat }, 'send-and-receive-event', deps.randomLetters);

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

/** What a test may change about a notification setup. */
export interface NotificationTestOptions extends TestScenarioOptions {
  /** Provisioner of the run; a fresh one on the real clock by default. */
  provisioner?: Provisioner;
  /** Whether the rule is provisioned before the run, so the run sees no change and no warmup; true by default. */
  preProvision?: boolean;
  /** Replaces the address lookup. */
  resolveAddress?: (signal: AbortSignal) => Promise<PublicAddress>;
}

/** The parts a notification scenario needs besides the F1 dependencies. */
export interface NotificationTestDeps {
  /** F1 dependencies; their redactor learns the values that `addSecret` gets. */
  deps: ScenarioDeps;
  /** Everything `runCheckNotification` takes. */
  notificationDeps: NotificationDeps;
  /** Logger kept inside `deps`. */
  logger: MemoryLogger;
  /** Receiver on a random loopback port. */
  receiver: Receiver;
  /** Address of the receiver over plain HTTP. */
  address: PublicAddress;
  /** Provisioner of the run. */
  provisioner: Provisioner;
  /** Finds the address. */
  resolveAddress: (signal: AbortSignal) => Promise<PublicAddress>;
  /** Values the run asked to mask. */
  secrets: string[];
  /** Adds a value to `secrets`. */
  addSecret: (value: string) => void;
  /** Stops the receiver; call it before the fake Hawk closes. */
  close(): Promise<void>;
}

/**
 * Builds the dependencies of a notification run on a fake Hawk: a receiver, an address that points at it and a rule already provisioned.
 * Notification waits are 800 ms with a pair wait of 200 ms unless the environment says otherwise.
 * @param hawk Running fake Hawk.
 * @param options Environment overrides, clock, provisioner and address lookup.
 * @returns F1 dependencies and the notification parts.
 */
export async function createNotificationTestDeps(hawk: FakeHawk, options: NotificationTestOptions = {}): Promise<NotificationTestDeps> {
  const { deps, logger } = createTestDeps(hawk, { ...options,
    env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
      TUNNEL_METRICS_URL: 'http://127.0.0.1:9',
      NOTIFICATION_TIMEOUT_MS: '800',
      NOTIFICATION_PAIR_WAIT_MS: '200',
      ...options.env } });
  const settings = notificationSettings(deps.config);
  const receiver = await startReceiver({ host: '127.0.0.1',
    port: 0,
    secret: settings.receiverSecret,
    clock: deps.clock,
    logger });
  const address = httpAddress(receiver.port);
  const provisionerDeps = { api: deps.api,
    projectId: deps.config.hawk.projectId,
    instanceId: deps.config.instanceId,
    secret: settings.receiverSecret,
    loop: settings.loop,
    warmupMs: settings.ruleCacheWarmupMs };

  if (options.preProvision !== false) {
    await createProvisioner({ ...provisionerDeps,
      clock: systemClock }).provision(address, AbortSignal.timeout(PRE_PROVISION_TIMEOUT_MS));
  }

  const secrets: string[] = [];
  const masking = createMutableRedactor(scenarioSecrets(deps.config));
  const addSecret = (value: string): void => {
    secrets.push(value);
    masking.add(value);
  };
  const provisioner = options.provisioner ?? createProvisioner({ ...provisionerDeps,
    clock: systemClock });
  const resolveAddress = options.resolveAddress ?? (() => Promise.resolve(address));
  const maskedDeps = { ...deps,
    redact: masking.redact };

  return {
    deps: maskedDeps,
    notificationDeps: { ...maskedDeps,
      receiver,
      provisioner,
      resolveAddress,
      addSecret },
    logger,
    receiver,
    address,
    provisioner,
    resolveAddress,
    secrets,
    addSecret,
    close: async () => receiver.close(),
  };
}

/** A notification context on a fake Hawk, with its parts exposed. */
export interface NotificationTestScenario extends NotificationTestDeps {
  /** Context to pass to stages. */
  context: NotificationContext;
  /** Plan of the run. */
  plan: RunPlan;
}

/**
 * Builds a context for notification stages run one by one against a fake Hawk.
 * @param hawk Running fake Hawk.
 * @param options Run number, overrides and clock.
 * @returns Context and its parts.
 */
export async function createNotificationTestScenario(hawk: FakeHawk, options: NotificationTestOptions = {}): Promise<NotificationTestScenario> {
  const parts = await createNotificationTestDeps(hawk, options);
  const { config, collector, api, clock } = parts.deps;
  const plan = planRun(config, { sequence: options.sequence ?? 1,
    transport: options.transport,
    repeat: options.repeat }, 'check-notification', parts.deps.randomLetters);

  return {
    ...parts,
    plan,
    context: { config,
      plan,
      collector,
      api,
      clock,
      pollScheduleMs: parts.deps.pollScheduleMs,
      state: { sendMayHaveReached: false },
      receiver: parts.receiver,
      provisioner: parts.provisioner,
      settings: notificationSettings(config),
      resolveAddress: parts.resolveAddress,
      addSecret: parts.addSecret,
      notification: { warmup: false } },
  };
}
