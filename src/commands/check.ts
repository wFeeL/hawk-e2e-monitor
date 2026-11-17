import { createCollectorClient } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { CheckCommand } from '../cli.js';
import { ConfigFailure, formatConfigErrors, notificationSettings, telegramSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import type { RunResult } from '../engine/result.js';
import { createMutableRedactor } from '../errors/redact.js';
import type { MutableRedactor } from '../errors/redact.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import { createLogger } from '../log/logger.js';
import { startReceiver } from '../receiver/server.js';
import { runSentryEnvelope } from '../scenarios/sentry-envelope/run.js';
import { runSourcemaps } from '../scenarios/sourcemaps/run.js';
import { runNewProject } from '../scenarios/new-project/run.js';
import { createdProjects } from '../storage/created-projects.js';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import { pendingProjects } from '../storage/pending-projects.js';
import { runEndpointsProbe } from '../scenarios/endpoints-probe/run.js';
import { runCheckNotification } from '../scenarios/check-notification/run.js';
import type { TelegramDeliveryDeps } from '../scenarios/telegram-delivery/run.js';
import { runTelegramDelivery } from '../scenarios/telegram-delivery/run.js';
import { runSendAndReceive, scenarioSecrets } from '../scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../scenarios/send-and-receive/run.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../storage/keys.js';
import { systemClock } from '../time/clock.js';
import { MS_PER_SECOND } from '../time/units.js';
import { readMatchChange, recordMatchChange } from './match-change.js';
import { refusalWhileServing } from './serving.js';
import { CHECK_NOTIFICATION, ENDPOINTS_PROBE, NEW_PROJECT, SEND_AND_RECEIVE_EVENT, SENTRY_ENVELOPE, SOURCEMAPS, TELEGRAM_DELIVERY } from '../scenarios/names.js';
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

    const selfSkipped = result.stages.some(stage => stage.status === 'skipped' && stage.details?.reason === 'rule_cache_warmup');
    const head = count === 0 ? 'ok' : `ok (${String(count)} ${count === 1 ? 'warning' : 'warnings'})`;

    io.stderr(`${head}${selfSkipped ? '; notification not checked: rule cache warmup' : ''}\n`);

    return 0;
  }

  io.stderr(masking.redact(`failed ${result.failedStage ?? 'unknown'} ${result.errorClass ?? 'unknown'}: ${result.message ?? ''}\n`));

  return 1;
}

/** What differs between the scenarios that run on the receiver. */
interface ReceiverScenario {
  /** Key of the history that holds the time their rule last changed matching. */
  key: string;
  /** Checks the settings of the scenario before anything starts; throws `ConfigFailure`. */
  validate: (config: Config) => void;
  /** Runs the scenario once. */
  run: (deps: TelegramDeliveryDeps, command: CheckCommand) => Promise<RunResult>;
}

/**
 * Runs a scenario that needs the receiver, with a receiver that is closed at the end when the command started it.
 * A rule changed by an earlier check may still be cached by Hawk, so the command waits that out before it checks.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @param scenario What differs between the scenarios.
 * @returns Exit code.
 */
async function runOnReceiver(command: CheckCommand, config: Config, io: CheckIo, deps: Partial<TelegramDeliveryDeps>, masking: MutableRedactor, scenario: ReceiverScenario): Promise<number> {
  const base = defaultDeps(config, io, masking);
  let receiver = deps.receiver;
  const startedHere = receiver === undefined;

  try {
    const settings = notificationSettings(config);

    scenario.validate(config);

    const clock = deps.clock ?? base.clock;

    if (receiver === undefined) {
      receiver = await startReceiver({ host: settings.receiverHost,
        port: settings.receiverPort,
        secret: settings.receiverSecret,
        clock,
        logger: base.logger });
    }

    const lastChange = deps.provisioner === undefined ? readMatchChange(config, io, scenario.key) : undefined;
    // A stored time in the future must not stretch the wait beyond the warmup.
    const remainingMs = lastChange === undefined
      ? 0
      : Math.min(Math.max(settings.ruleCacheWarmupMs - (clock.wallTime().getTime() - lastChange), 0), settings.ruleCacheWarmupMs);

    // A rule changed by an earlier check may still be cached by Hawk, so wait instead of skipping the notification.
    if (remainingMs > 0) {
      io.stderr(`waiting ${String(Math.ceil(remainingMs / MS_PER_SECOND))} s for Hawk to reload notification rules\n`);
      await clock.sleep(remainingMs);

      // A serve may have started while the command waited.
      const refusal = refusalWhileServing(config, clock.wallTime());

      if (refusal !== undefined) {
        io.stderr(refusal);

        return 1;
      }
    }

    const result = await scenario.run({ ...base,
      ...deps,
      ...deps.provisioner === undefined
        // A stored time in the future is clamped, so the provisioner sees the waited warmup as over.
        ? { ...lastChange === undefined ? {} : { lastMatchChangeAtWallMs: Math.min(lastChange, clock.wallTime().getTime() - settings.ruleCacheWarmupMs) },
            onMatchChange: (wallMs: number) => {
              recordMatchChange(config, new Date(wallMs), io, scenario.key);
            } }
        : {},
      receiver,
      addSecret: deps.addSecret ?? masking.add }, command);

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

/**
 * Runs `check-notification` on the receiver.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runNotificationCommand: CheckScenario = async (command, config, io, deps, masking) => runOnReceiver(command, config, io, deps, masking, { key: MATCH_CHANGED_KEY,
  validate: () => undefined,
  run: async (runDeps, parsed) => runCheckNotification(runDeps, { sequence: parsed.sequence,
    transport: parsed.transport,
    repeat: parsed.repeat ? true : undefined }) });

/**
 * Runs `telegram-delivery` on the receiver, with its own rule and its own warmup key.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runTelegramDeliveryCommand: CheckScenario = async (command, config, io, deps, masking) => runOnReceiver(command, config, io, deps, masking, { key: TELEGRAM_MATCH_CHANGED_KEY,
  validate: (checked) => {
    telegramSettings(checked);
  },
  run: async (runDeps, parsed) => runTelegramDelivery(runDeps, { sequence: parsed.sequence,
    transport: parsed.transport,
    repeat: parsed.repeat ? true : undefined }) });

/** Runs one scenario for `check` and returns the exit code. */
type CheckScenario = (command: CheckCommand, config: Config, io: CheckIo, deps: Partial<TelegramDeliveryDeps>, masking: MutableRedactor) => Promise<number>;

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
 * Runs `new-project` with the record of created projects in the history file, so a project left behind is found by the sweep.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runNewProjectCommand: CheckScenario = async (command, config, io, deps, masking) => {
  const { databasePath } = config.monitoring;
  let history;

  try {
    history = createHistory(openDatabase(databasePath));
  } catch (error) {
    // Nothing is created in Hawk before the id of a project has a place to be recorded.
    io.stderr(`cannot open ${databasePath} to record the project: ${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  }

  try {
    const result = await runNewProject({ ...defaultDeps(config, io, masking),
      ...deps.pollScheduleMs === undefined ? {} : { pollScheduleMs: deps.pollScheduleMs },
      addSecret: masking.add,
      projects: createdProjects(history),
      pending: pendingProjects(history) }, { sequence: command.sequence });

    io.stdout(`${JSON.stringify(result)}\n`);

    return summarize(result, io, masking);
  } finally {
    history.close();
  }
};

/**
 * Runs `sourcemaps` and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runSourcemapsCommand: CheckScenario = async (command, config, io, deps, masking) => {
  const result = await runSourcemaps({ ...defaultDeps(config, io, masking),
    ...deps.pollScheduleMs === undefined ? {} : { pollScheduleMs: deps.pollScheduleMs } }, { sequence: command.sequence });

  io.stdout(`${JSON.stringify(result)}\n`);

  return summarize(result, io, masking);
};

/**
 * Runs `sentry-envelope` and prints the result.
 * @param command Parsed `check` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @param masking Redactor shared with the logger.
 * @returns Exit code.
 */
const runSentryEnvelopeCommand: CheckScenario = async (command, config, io, deps, masking) => {
  const result = await runSentryEnvelope({ ...defaultDeps(config, io, masking),
    ...deps.pollScheduleMs === undefined ? {} : { pollScheduleMs: deps.pollScheduleMs } }, { sequence: command.sequence });

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
  [NEW_PROJECT]: runNewProjectCommand,
  [SOURCEMAPS]: runSourcemapsCommand,
  [SENTRY_ENVELOPE]: runSentryEnvelopeCommand,
  [TELEGRAM_DELIVERY]: runTelegramDeliveryCommand,
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
export async function runCheckCommand(command: CheckCommand, config: Config, io: CheckIo, deps: Partial<TelegramDeliveryDeps> = {}): Promise<number> {
  const refusal = refusalWhileServing(config, deps.clock?.wallTime() ?? new Date());

  if (refusal !== undefined) {
    io.stderr(refusal);

    return 1;
  }

  const masking = createMutableRedactor(scenarioSecrets(config));

  return CHECKS[command.scenario](command, config, io, deps, masking);
}
