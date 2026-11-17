import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import type { ProvisionCommand } from '../cli.js';
import { ConfigFailure, formatConfigErrors, notificationSettings, telegramSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import { createMutableRedactor } from '../errors/redact.js';
import { isCheckError } from '../errors/taxonomy.js';
import { createLogger } from '../log/logger.js';
import { resolvePublicAddress } from '../notifications/address.js';
import type { PublicAddress } from '../notifications/address.js';
import { createProvisioner } from '../notifications/provisioning.js';
import { scenarioSecrets } from '../scenarios/shared/deps.js';
import { TELEGRAM_DELIVERY } from '../scenarios/names.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../storage/keys.js';
import { systemClock, timeoutSignal } from '../time/clock.js';
import type { TimeoutSignal } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import type { CheckIo } from './check.js';
import { refusalWhileServing } from './serving.js';
import { recordMatchChange } from './match-change.js';
import { MS_PER_SECOND } from '../time/units.js';

/** Replacements for the default dependencies, for tests. */
export interface ProvisionDeps {
  /** Hawk API client. */
  api: HawkApi;
  /** Clock of the warmup wait. */
  clock: Clock;
  /** Finds the public address instead of reading it from the settings. */
  resolveAddress: (signal: AbortSignal) => Promise<PublicAddress>;
}

/**
 * Brings the notification rule of the instance to the wanted state and prints the result.
 * @param command Parsed `provision` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @returns Exit code: 0 on success, 1 on a failure.
 */
export async function runProvisionCommand(command: ProvisionCommand, config: Config, io: CheckIo, deps: Partial<ProvisionDeps> = {}): Promise<number> {
  const { redact, add } = createMutableRedactor(scenarioSecrets(config));
  const clock = deps.clock ?? systemClock;
  const refusal = refusalWhileServing(config, clock.wallTime());

  if (refusal !== undefined) {
    io.stderr(refusal);

    return 1;
  }

  const logger = createLogger({ level: config.logLevel,
    write: (line) => {
      io.stderr(`${redact(line)}\n`);
    } });

  let deadline: TimeoutSignal | undefined;

  try {
    const settings = notificationSettings(config);
    // Rule T exists only for a configuration that chooses the scenario; its settings are checked before anything changes.
    const bot = config.monitoring.scenarios.includes(TELEGRAM_DELIVERY) ? telegramSettings(config) : undefined;

    deadline = timeoutSignal(clock, settings.setupTimeoutMs);

    const { signal } = deadline;
    const api = deps.api ?? createHawkApi({ transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retry: config.retry }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock,
    retry: config.retry });
    const address = deps.resolveAddress === undefined
      ? await resolvePublicAddress(settings, { httpTimeoutMs: config.httpTimeoutMs,
        clock,
        retry: config.retry }, signal)
      : await deps.resolveAddress(signal);

    add(address.baseUrl);
    add(address.hostname);

    const provisionerDeps = { api,
      clock,
      projectId: config.hawk.projectId,
      instanceId: config.instanceId,
      secret: settings.receiverSecret,
      loop: settings.loop,
      warmupMs: settings.ruleCacheWarmupMs };
    const provisioner = createProvisioner({ ...provisionerDeps,
      kinds: ['newEvents', 'threshold'] });
    const telegramProvisioner = bot === undefined
      ? undefined
      : createProvisioner({ ...provisionerDeps,
          loop: false,
          kinds: ['telegram'],
          notifyUrl: bot.notifyUrl });
    const result = await provisioner.provision(address, signal);
    const telegramResult = await telegramProvisioner?.provision(address, signal);

    logger.info('provisioned', { ...result });

    if (telegramResult !== undefined) {
      logger.info('provisioned the Telegram rule', { ...telegramResult });
    }

    // One object with a field for each provisioner; a configuration without the Telegram scenario prints the plain result as before.
    io.stdout(`${redact(JSON.stringify(telegramResult === undefined
      ? result
      : { notification: result,
          telegram: telegramResult }))}\n`);

    if (result.matchChanged) {
      recordMatchChange(config, clock.wallTime(), io, MATCH_CHANGED_KEY);
    }

    if (telegramResult?.matchChanged === true) {
      recordMatchChange(config, clock.wallTime(), io, TELEGRAM_MATCH_CHANGED_KEY);
    }

    if ((result.matchChanged || telegramResult?.matchChanged === true) && command.wait) {
      const remainingMs = Math.max(provisioner.warmupRemainingMs(), telegramProvisioner?.warmupRemainingMs() ?? 0);

      io.stderr(`${redact(`waiting ${String(Math.ceil(remainingMs / MS_PER_SECOND))} s for Hawk to reload notification rules`)}\n`);
      await clock.sleep(remainingMs);
    }

    return 0;
  } catch (error) {
    if (error instanceof ConfigFailure) {
      io.stderr(formatConfigErrors(error.errors));

      return 1;
    }

    const errorClass = isCheckError(error) ? error.errorClass : 'monitor_internal';
    const message = error instanceof Error ? error.message : String(error);

    io.stderr(`${redact(`failed ${errorClass}: ${message}`)}\n`);

    return 1;
  } finally {
    deadline?.dispose();
  }
}
