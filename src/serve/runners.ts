import type { ScenarioRunner } from '../scheduler/scheduler.js';
import { CHECK_NOTIFICATION, ENDPOINTS_PROBE, SEND_AND_RECEIVE_EVENT } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';
import { runSendAndReceive } from '../scenarios/send-and-receive/run.js';
import { StartupError } from '../app.js';
import type { Check } from '../http/internal-server.js';
import { setupCheckNotification } from './notification-setup.js';
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
 * Stands in for the probe until its runner exists.
 * @returns Never; the probe cannot be started yet.
 * @throws StartupError always.
 */
const setupProbe: SetupScenario = async (): Promise<ScenarioSetup> => Promise.reject(new StartupError(`${ENDPOINTS_PROBE} is not implemented yet`));

/** One entry per scenario; a new scenario is added here. */
const SETUPS: Readonly<Record<ScenarioName, SetupScenario>> = {
  [SEND_AND_RECEIVE_EVENT]: setupSendAndReceive,
  [CHECK_NOTIFICATION]: setupCheckNotification,
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

    built.runners[scenario] = setup.runner;

    if (setup.beforeFirstRun !== undefined) {
      built.beforeFirstRun[scenario] = setup.beforeFirstRun;
    }

    built.readiness.push(...setup.readiness ?? []);

    if (setup.receiverPort !== undefined) {
      built.receiverPort = setup.receiverPort;
    }
  }

  return built;
}
