import type { ScenarioRunner } from '../scheduler/scheduler.js';
import { CHECK_NOTIFICATION, ENDPOINTS_PROBE, NEW_PROJECT, SEND_AND_RECEIVE_EVENT, SENTRY_ENVELOPE, SOURCEMAPS, TELEGRAM_DELIVERY } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import { usesTunnel } from '../config/scenario.js';
import { probeReceiver, resolvePublicAddress } from '../notifications/address.js';
import { runEndpointsProbe } from '../scenarios/endpoints-probe/run.js';
import type { ReceiverCheck } from '../scenarios/endpoints-probe/stages.js';
import { runSentryEnvelope } from '../scenarios/sentry-envelope/run.js';
import { runSourcemaps } from '../scenarios/sourcemaps/run.js';
import { runNewProject } from '../scenarios/new-project/run.js';
import { createdProjects } from '../storage/created-projects.js';
import { pendingProjects } from '../storage/pending-projects.js';
import { runSendAndReceive } from '../scenarios/send-and-receive/run.js';
import type { Check } from '../http/internal-server.js';
import { sharedReceiver } from './receiver-setup.js';
import { setupCheckNotification } from './notification-setup.js';
import { setupTelegramDelivery } from './telegram-setup.js';
import type { RunnerContext, ScenarioSetup, SetupScenario } from './scenario-setup.js';

/** What the scheduler and the internal server get from the scenarios of the configuration. */
export interface BuiltRunners {
  /** Runner of each enabled scenario. */
  runners: Partial<Record<ScenarioName, ScenarioRunner>>;
  /** Wait before the first run of a scenario. */
  beforeFirstRun: Partial<Record<ScenarioName, (signal: AbortSignal) => Promise<void>>>;
  /** Readiness checks the scenarios add. */
  readiness: Check[];
  /** Port of the receiver, when a scenario started one. */
  receiverPort?: number;
}

/**
 * Sets up `send-and-receive-event`, which needs nothing besides the clients.
 * @param context Everything a scenario needs to be set up.
 * @returns Its runner.
 */
const setupSendAndReceive: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;

  return Promise.resolve({
    runner: async ({ runId, sequence, signal }) => runSendAndReceive({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal }, { sequence,
      runId }),
  });
};

/**
 * Sets up `endpoints-probe`, which needs the clients and, beside a notification scenario, the receiver and its tunnel.
 * The wait for the tunnel starts here, not at the first notification run, so the stage is not skipped for a whole interval after a restart.
 * @param context Everything a scenario needs to be set up.
 * @returns Its runner.
 */
const setupProbe: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;
  let receiverCheck: ReceiverCheck | undefined;

  if (usesTunnel(config.monitoring.scenarios)) {
    const runtime = await sharedReceiver(context);
    const stop = new AbortController();

    context.closers.push(() => {
      stop.abort();
    });
    void runtime.waitForTunnel(stop.signal);
    receiverCheck = {
      // One attempt each: a short gap fails one probe, and the alert needs several in a row.
      findAddress: signal => (overrides.resolveAddress ?? resolvePublicAddress)(runtime.settings, { httpTimeoutMs: config.httpTimeoutMs,
        clock,
        retry: { attempts: 1,
          delaysMs: [] } }, signal),
      probe: async (address, signal) => probeReceiver(address, runtime.settings.receiverSecret, runtime.receiver.nonce, { httpTimeoutMs: config.httpTimeoutMs,
        clock,
        attempts: 1,
        retry: config.retry }, signal),
      tunnelWaited: runtime.tunnelWaited,
      addSecret: masking.add,
    };
  }

  return Promise.resolve({
    runner: async ({ runId, sequence, signal }) => runEndpointsProbe({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...receiverCheck === undefined ? {} : { receiverCheck },
      signal }, { sequence,
      runId }),
  });
};

/**
 * Sets up `new-project`, which keeps the ids of its projects in the history for the sweep.
 * @param context Everything a scenario needs to be set up.
 * @returns Its runner.
 */
const setupNewProject: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, history, clock, logger, masking, api, collector, overrides } = context;
  const projects = createdProjects(history);
  const pending = pendingProjects(history);

  return Promise.resolve({
    runner: async ({ runId, sequence, signal }) => runNewProject({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      addSecret: masking.add,
      projects,
      pending,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal }, { sequence,
      runId }),
  });
};

/**
 * Sets up `sourcemaps`, which needs nothing besides the clients.
 * @param context Everything a scenario needs to be set up.
 * @returns Its runner.
 */
const setupSourcemaps: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;

  return Promise.resolve({
    runner: async ({ runId, sequence, signal }) => runSourcemaps({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal }, { sequence,
      runId }),
  });
};

/**
 * Sets up `sentry-envelope`, which needs nothing besides the clients.
 * @param context Everything a scenario needs to be set up.
 * @returns Its runner.
 */
const setupSentryEnvelope: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;

  return Promise.resolve({
    runner: async ({ runId, sequence, signal }) => runSentryEnvelope({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal }, { sequence,
      runId }),
  });
};

/** One entry per scenario; a new scenario is added here. */
const SETUPS: Readonly<Record<ScenarioName, SetupScenario>> = {
  [SEND_AND_RECEIVE_EVENT]: setupSendAndReceive,
  [CHECK_NOTIFICATION]: setupCheckNotification,
  [NEW_PROJECT]: setupNewProject,
  [SOURCEMAPS]: setupSourcemaps,
  [SENTRY_ENVELOPE]: setupSentryEnvelope,
  [TELEGRAM_DELIVERY]: setupTelegramDelivery,
  [ENDPOINTS_PROBE]: setupProbe,
};

/**
 * Sets up every scenario of the configuration, in the order the configuration lists them.
 * @param context Everything a scenario needs to be set up.
 * @returns Runners, waits before the first run and extra readiness checks.
 * @throws StartupError when a scenario cannot start what it needs.
 */
export async function buildRunners(context: RunnerContext): Promise<BuiltRunners> {
  const built: BuiltRunners = { runners: {},
    beforeFirstRun: {},
    readiness: [] };

  for (const scenario of context.config.monitoring.scenarios) {
    const setup = await SETUPS[scenario](context);

    built.runners[scenario] = context.overrides.runners?.[scenario] ?? setup.runner;

    if (setup.beforeFirstRun !== undefined) {
      built.beforeFirstRun[scenario] = setup.beforeFirstRun;
    }

    // Scenarios that share a receiver each hand over its check; it is listed once.
    built.readiness.push(...(setup.readiness ?? []).filter(check => !built.readiness.some(known => known.name === check.name)));

    if (setup.receiverPort !== undefined) {
      built.receiverPort = setup.receiverPort;
    }
  }

  return built;
}
