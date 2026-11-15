import { createProvisioner } from '../notifications/provisioning.js';
import type { Provisioner } from '../notifications/provisioning.js';
import { runCheckNotification } from '../scenarios/check-notification/run.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';
import { matchChangeOptions, sharedReceiver } from './receiver-setup.js';
import type { ScenarioSetup, SetupScenario } from './scenario-setup.js';

/**
 * Builds the runner of `check-notification` around the receiver the notification scenarios share.
 * @param context Everything a scenario needs to be set up.
 * @returns Runner, the wait for the tunnel and the readiness check of the receiver.
 * @throws StartupError when the receiver cannot listen.
 */
export const setupCheckNotification: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;
  const runtime = await sharedReceiver(context);
  const { settings, receiver, findAddress, lastHostname } = runtime;
  const provisioner: Provisioner = createProvisioner({ api,
    clock,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    secret: settings.receiverSecret,
    loop: settings.loop,
    kinds: ['newEvents', 'threshold'],
    warmupMs: settings.ruleCacheWarmupMs,
    ...matchChangeOptions(context, MATCH_CHANGED_KEY) });

  return {
    runner: async ({ runId, sequence, signal }) => runCheckNotification({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal,
      receiver,
      provisioner,
      resolveAddress: findAddress,
      addSecret: masking.add,
      lastHostname,
      ...overrides.addressPollMs === undefined ? {} : { addressPollMs: overrides.addressPollMs } }, { sequence,
      runId }),
    beforeFirstRun: runtime.waitForTunnel,
    readiness: runtime.readiness,
    receiverPort: receiver.port,
  };
};
