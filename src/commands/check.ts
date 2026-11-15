import { createCollectorClient } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { CheckCommand } from '../cli.js';
import { ConfigFailure, formatConfigErrors, notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import type { RunResult } from '../engine/result.js';
import { createMutableRedactor } from '../errors/redact.js';
import type { MutableRedactor } from '../errors/redact.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import { createLogger } from '../log/logger.js';
import { startReceiver } from '../receiver/server.js';
import { runEndpointsProbe } from '../scenarios/endpoints-probe/run.js';
import { runCheckNotification } from '../scenarios/check-notification/run.js';
import type { NotificationDeps } from '../scenarios/check-notification/run.js';
import { runSendAndReceive, scenarioSecrets } from '../scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../scenarios/send-and-receive/run.js';
import { systemClock } from '../time/clock.js';
import { refusalWhileServing } from './serving.js';
import { CHECK_NOTIFICATION, ENDPOINTS_PROBE, SEND_AND_RECEIVE_EVENT } from '../scenarios/names.js';
import type { ScenarioName } from '../scenarios/names.js';

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
 * @param io Output; log lines go to its stderr through the masking.
 * @param masking Redactor that learns secrets while the run goes.
 * @returns Clients, clock, logger and redactor.
 */
function defaultDeps(config: Config, io: CheckIo, masking: MutableRedactor): ScenarioDeps {
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
        io.stderr(`${masking.redact(line)}\n`);
      } }),
    redact: masking.redact,
    collector: createCollectorClient({ endpoints: collectorEndpoints(token, config.hawk.collectorUrl),
      httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retry: config.retry }),
    api: createHawkApi({
      transport: createGraphqlTransport({ url: config.hawk.apiUrl,
        httpTimeoutMs: config.httpTimeoutMs,
        clock,
        retry: config.retry }),
      email: config.hawk.email,
      password: config.hawk.password,
      clock,
      retry: config.retry,
    }),
  };
}

/**
 * Writes the verdict line of a finished run to stderr.
 * @param result Result of the run.
 * @param io Output streams.
 * @param masking Redactor for the text of the failure.
 * @returns Exit code: 0 when the run is ok, 1 when it failed.
 */
function summarize(result: RunResult, io: CheckIo, masking: MutableRedactor): number {
  if (result.status === 'ok') {
    const count = result.warnings.length;

    io.stderr(count === 0 ? 'ok\n' : `ok (${String(count)} ${count === 1 ? 'warning' : 'warnings'})\n`);

    return 0;
  }

  io.stderr(masking.redact(`failed ${result.failedStage ?? 'unknown'} ${result.errorClass ?? 'unknown'}: ${result.message ?? ''}\n`));

  return 1;
}

/**
 * Runs `check-notification` with a receiver that is closed at the end when the command started it.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
async function runNotificationCommand(command: CheckCommand, config: Config, io: CheckIo, deps: Partial<NotificationDeps>, masking: MutableRedactor): Promise<number> {
  const base = defaultDeps(config, io, masking);
  let receiver = deps.receiver;
  const startedHere = receiver === undefined;

  try {
    const settings = notificationSettings(config);

    if (receiver === undefined) {
      receiver = await startReceiver({ host: settings.receiverHost,
        port: settings.receiverPort,
        secret: settings.receiverSecret,
        clock: systemClock,
        logger: base.logger });
    }

    const result = await runCheckNotification({ ...base,
      ...deps,
      receiver,
      addSecret: deps.addSecret ?? masking.add }, { sequence: command.sequence,
      transport: command.transport,
      repeat: command.repeat ? true : undefined });

    io.stdout(`${JSON.stringify(result)}\n`);

    return summarize(result, io, masking);
  } catch (error) {
    if (error instanceof ConfigFailure) {
      io.stderr(formatConfigErrors(error.errors));
    } else {
      io.stderr(masking.redact(`failed monitor_internal: ${error instanceof Error ? error.message : String(error)}\n`));
    }

    return 1;
  } finally {
    if (startedHere) {
      await receiver?.close();
    }
  }
}

/** Runs one scenario for `check` and returns the exit code. */
type CheckScenario = (command: CheckCommand, config: Config, io: CheckIo, deps: Partial<NotificationDeps>, masking: MutableRedactor) => Promise<number>;

/**
 * Runs `send-and-receive-event` and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runSendAndReceiveCommand: CheckScenario = async (command, config, io, deps, masking) => {
  const result = await runSendAndReceive({ ...defaultDeps(config, io, masking),
    ...deps }, { sequence: command.sequence,
    transport: command.transport,
    repeat: command.repeat ? true : undefined });

  io.stdout(`${JSON.stringify(result)}\n`);

  return summarize(result, io, masking);
};

/**
 * Runs `endpoints-probe` and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runProbeCommand: CheckScenario = async (command, config, io, deps, masking) => {
  const result = await runEndpointsProbe({ ...defaultDeps(config, io, masking),
    ...deps }, { sequence: command.sequence });

  io.stdout(`${JSON.stringify(result)}\n`);

  return summarize(result, io, masking);
};

/** One entry per scenario; a new scenario is added here. */
const CHECKS: Readonly<Record<ScenarioName, CheckScenario>> = {
  [SEND_AND_RECEIVE_EVENT]: runSendAndReceiveCommand,
  [CHECK_NOTIFICATION]: runNotificationCommand,
  [ENDPOINTS_PROBE]: runProbeCommand,
};

/**
 * Runs one scenario and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @returns Exit code: 0 when the run is ok, 1 when it failed.
 */
export async function runCheckCommand(command: CheckCommand, config: Config, io: CheckIo, deps: Partial<NotificationDeps> = {}): Promise<number> {
  const refusal = refusalWhileServing(config, deps.clock?.wallTime() ?? new Date());

  if (refusal !== undefined) {
    io.stderr(refusal);

    return 1;
  }

  const masking = createMutableRedactor(scenarioSecrets(config));

  return CHECKS[command.scenario](command, config, io, deps, masking);
}
