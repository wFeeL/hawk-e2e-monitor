import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import type { ProvisionCommand } from '../cli.js';
import { ConfigFailure, formatConfigErrors, notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import { createMutableRedactor } from '../errors/redact.js';
import { isCheckError } from '../errors/taxonomy.js';
import { createLogger } from '../log/logger.js';
import { resolvePublicAddress } from '../notifications/address.js';
import type { PublicAddress } from '../notifications/address.js';
import { createProvisioner } from '../notifications/provisioning.js';
import { scenarioSecrets } from '../scenarios/send-and-receive/run.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import type { CheckIo } from './check.js';
import { refusalWhileServing } from './serving.js';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';

const MS_PER_SECOND = 1000;

/** Replacements for the default dependencies, for tests. */
export interface ProvisionDeps {
  /** Hawk API client. */
  api: HawkApi;
  /** Clock of the warmup wait. */
  clock: Clock;
  /** Pauses between attempts of repeated calls. */
  retryDelaysMs: readonly number[];
  /** Finds the public address instead of reading it from the settings. */
  resolveAddress: (signal: AbortSignal) => Promise<PublicAddress>;
}

/**
 * Tells `serve` when matching changed, so it does not trust the old rule after a restart.
 * A failed write is only reported: the rule itself was changed.
 * @param config Validated configuration.
 * @param at Time of the change.
 * @param io Output streams.
 */
function recordMatchChange(config: Config, at: Date, io: CheckIo): void {
  try {
    const history = createHistory(openDatabase(config.monitoring.databasePath));

    try {
      history.setKv(MATCH_CHANGED_KEY, at.toISOString());
    } finally {
      history.close();
    }
  } catch (error) {
    io.stderr(`could not record the rule change in ${config.monitoring.databasePath}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
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

  try {
    const settings = notificationSettings(config);
    const signal = AbortSignal.timeout(settings.setupTimeoutMs);
    const api = deps.api ?? createHawkApi({ transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock: systemClock,
      ...deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs } }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock: systemClock });
    const address = deps.resolveAddress === undefined
      ? await resolvePublicAddress(settings, { httpTimeoutMs: config.httpTimeoutMs,
        clock: systemClock,
        ...deps.retryDelaysMs === undefined ? {} : { retryDelaysMs: deps.retryDelaysMs } }, signal)
      : await deps.resolveAddress(signal);

    add(address.baseUrl);
    add(address.hostname);

    const provisioner = createProvisioner({ api,
      clock,
      projectId: config.hawk.projectId,
      instanceId: config.instanceId,
      secret: settings.receiverSecret,
      loop: settings.loop,
      warmupMs: settings.ruleCacheWarmupMs });
    const result = await provisioner.provision(address, signal);

    logger.info('provisioned', { ...result });
    io.stdout(`${redact(JSON.stringify(result))}\n`);

    if (result.matchChanged) {
      recordMatchChange(config, clock.wallTime(), io);
    }

    if (result.matchChanged && command.wait) {
      const remainingMs = provisioner.warmupRemainingMs();

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
  }
}
