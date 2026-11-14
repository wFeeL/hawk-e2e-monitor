import { createCollectorClient } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { CheckCommand } from '../cli.js';
import type { Config } from '../config/load.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import { createLogger } from '../log/logger.js';
import { createScenarioRedactor, runSendAndReceive } from '../scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../scenarios/send-and-receive/run.js';
import { systemClock } from '../time/clock.js';

/** Where the command writes. */
export interface CheckIo {
  /** Writes text to stdout; the caller adds line breaks. */
  stdout: (text: string) => void;
  /** Writes text to stderr; the caller adds line breaks. */
  stderr: (text: string) => void;
}

/**
 * Builds the dependencies of a run from the configuration.
 * @param config Validated configuration.
 * @param io Output; log lines go to its stderr.
 * @returns Clients, clock, logger and redactor.
 */
function defaultDeps(config: Config, io: CheckIo): ScenarioDeps {
  const token = decodeIntegrationToken(config.hawk.integrationToken);

  if (token === undefined) {
    throw new Error('HAWK_INTEGRATION_TOKEN does not decode, although the configuration was validated');
  }

  const clock = systemClock;

  return {
    config,
    clock,
    logger: createLogger({ level: config.logLevel,
      write: (line) => {
        io.stderr(`${line}\n`);
      } }),
    redact: createScenarioRedactor(config),
    collector: createCollectorClient({ endpoints: collectorEndpoints(token, config.hawk.collectorUrl),
      httpTimeoutMs: config.httpTimeoutMs,
      clock }),
    api: createHawkApi({
      transport: createGraphqlTransport({ url: config.hawk.apiUrl,
        httpTimeoutMs: config.httpTimeoutMs,
        clock }),
      email: config.hawk.email,
      password: config.hawk.password,
      clock,
    }),
  };
}

/**
 * Runs one scenario and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @returns Exit code: 0 when the run is ok, 1 when it failed.
 */
export async function runCheckCommand(command: CheckCommand, config: Config, io: CheckIo, deps: Partial<ScenarioDeps> = {}): Promise<number> {
  const result = await runSendAndReceive({ ...defaultDeps(config, io),
    ...deps }, { sequence: command.sequence,
    transport: command.transport,
    repeat: command.repeat ? true : undefined });

  io.stdout(`${JSON.stringify(result)}\n`);

  if (result.status === 'ok') {
    io.stderr('ok\n');

    return 0;
  }

  io.stderr(`failed ${result.failedStage ?? 'unknown'} ${result.errorClass ?? 'unknown'}: ${result.message ?? ''}\n`);

  return 1;
}
