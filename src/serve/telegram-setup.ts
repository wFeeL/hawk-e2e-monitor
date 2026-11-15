import { StartupError } from '../app.js';
import { createTelegramClient } from '../clients/telegram.js';
import { ConfigFailure, formatConfigErrors, telegramSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import { createProvisioner } from '../notifications/provisioning.js';
import { runTelegramDelivery } from '../scenarios/telegram-delivery/run.js';
import { TELEGRAM_MATCH_CHANGED_KEY } from '../storage/keys.js';
import { matchChangeOptions, sharedReceiver } from './receiver-setup.js';
import type { ScenarioSetup, SetupScenario } from './scenario-setup.js';

/**
 * Reads the Telegram settings, which only a chosen telegram-delivery needs.
 * @param config Configuration to read.
 * @returns The settings with the token and the notify address present and well formed.
 * @throws StartupError naming each missing or malformed variable, without its value.
 */
function settingsOrStartupError(config: Config): ReturnType<typeof telegramSettings> {
  try {
    return telegramSettings(config);
  } catch (error) {
    if (error instanceof ConfigFailure) {
      throw new StartupError(formatConfigErrors(error.errors).trimEnd(), { cause: error });
    }

    throw error;
  }
}

/**
 * Builds the runner of `telegram-delivery` around the receiver the notification scenarios share.
 * @param context Everything a scenario needs to be set up.
 * @returns Runner, the wait for the tunnel and the readiness check of the receiver.
 * @throws StartupError when a setting is missing or the receiver cannot listen.
 */
export const setupTelegramDelivery: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, clock, logger, masking, api, collector, overrides } = context;
  const bot = settingsOrStartupError(config);
  const runtime = await sharedReceiver(context);
  const { settings, receiver, findAddress, lastHostname } = runtime;
  const telegramClient = createTelegramClient({ apiUrl: bot.apiUrl,
    token: bot.botToken,
    httpTimeoutMs: config.httpTimeoutMs,
    clock });
  const provisioner = createProvisioner({ api,
    clock,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    secret: settings.receiverSecret,
    loop: false,
    kinds: ['telegram'],
    notifyUrl: bot.notifyUrl,
    warmupMs: settings.ruleCacheWarmupMs,
    ...matchChangeOptions(context, TELEGRAM_MATCH_CHANGED_KEY) });

  return {
    runner: async ({ runId, sequence, signal }) => runTelegramDelivery({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal,
      receiver,
      provisioner,
      telegramClient,
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
