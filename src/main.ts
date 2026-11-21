import process from 'node:process';
import { StartupError } from './app.js';
import { configErrorExitCode, parseCommand } from './cli.js';
import { runCheckCommand } from './commands/check.js';
import { runHistoryCommand } from './commands/history.js';
import { runProvisionCommand } from './commands/provision.js';
import { runRunCommand } from './commands/run.js';
import type { Config } from './config/load.js';
import { formatConfigErrors, loadConfig, loadHistoryConfig } from './config/load.js';
import { describeConfig } from './config/describe.js';
import type { ParsedEnv } from './config/schema.js';
import { createLogger } from './log/logger.js';
import { startServe } from './serve/serve.js';
import type { ServeHandle } from './serve/serve.js';
import { eventsSentPer30Days } from './storage/outcome.js';
import { SERVICE_VERSION } from './version.js';

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Starts the service and wires process-level error and signal handling.
 * An unhandled rejection or uncaught exception ends the process with code 1, so the container restarts it
 * instead of running on in an unknown state.
 * @param config Validated configuration.
 * @param env Parsed variables for the startup summary.
 * @returns Exit code for a failed startup, 0 once the service is running (it stops itself via `process.exit`).
 */
async function serve(config: Config, env: ParsedEnv): Promise<number> {
  const logger = createLogger({ level: config.logLevel });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { error: reason });
    // eslint-disable-next-line n/no-process-exit -- a fatal error ends the process and the container restarts it
    process.exit(1);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error });
    // eslint-disable-next-line n/no-process-exit -- a fatal error ends the process and the container restarts it
    process.exit(1);
  });

  const summary = describeConfig(env);

  logger.info('starting', { version: SERVICE_VERSION,
    config: summary.values });
  for (const warning of summary.warnings) {
    logger.warn(warning);
  }

  logger.info('events sent per 30 days', { eventsSentPer30Days: Math.round(eventsSentPer30Days(config)),
    note: 'the quota ignores events that cleanup removes; the rate limits of the plan apply' });

  if (config.monitoring.alertNotifyUrl === undefined) {
    logger.warn('ALERT_NOTIFY_URL is not set: alerts are written to the log and not delivered');
  }

  let app: ServeHandle | undefined;
  const starting = new AbortController();
  let stopRequested = false;
  let pendingSignal = '';

  const shutdown = (): void => {
    app?.stop().then(() => {
      logger.info('stopped');
      // eslint-disable-next-line n/no-process-exit -- exit explicitly: keep-alive sockets or leftover timers could hold the event loop open after a clean stop
      process.exit(0);
    }, (error: unknown) => {
      logger.error('stop failed', { error });
      // eslint-disable-next-line n/no-process-exit -- the stop failed, so end with an error code instead of hanging
      process.exit(1);
    });
  };

  // Handlers go in before startApp so a signal during startup is not lost.
  for (const name of STOP_SIGNALS) {
    process.once(name, (signal: string) => {
      if (app === undefined) {
        logger.info('stopping', { signal,
          during: 'startup' });
        stopRequested = true;
        pendingSignal = signal;
        starting.abort();
      } else {
        logger.info('stopping', { signal });
        shutdown();
      }
    });
  }

  try {
    app = await startServe({ config,
      logger,
      signal: starting.signal });
  } catch (error: unknown) {
    if (!(error instanceof StartupError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);

    // A stop the operator asked for during startup is not a failure.
    if (stopRequested) {
      logger.info('stopped during startup', { signal: pendingSignal,
        reason: error.message });

      return 0;
    }

    // The message was printed above; a stack of a startup error says nothing more.
    logger.error('startup failed', { error: error.message });

    return 1;
  }

  logger.info('listening', { host: config.internal.host,
    port: app.port });

  if (stopRequested) {
    logger.info('stopping', { signal: pendingSignal,
      after: 'startup' });
    shutdown();
  }

  return 0;
}

const io = {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
};

/**
 * Parses the command line, loads the configuration and runs the command.
 * @param argv Arguments after the script name.
 * @param env Process environment.
 * @returns Process exit code.
 */
async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = parseCommand(argv);

  if (command.kind === 'usage') {
    process.stderr.write(command.message);

    return 2;
  }

  if (command.kind === 'help') {
    process.stdout.write(command.text);

    return 0;
  }

  if (command.kind === 'version') {
    process.stdout.write(`${SERVICE_VERSION}\n`);

    return 0;
  }

  if (command.kind === 'history') {
    // History only reads the database file, so it does not ask for the Hawk settings.
    const history = loadHistoryConfig(env);

    if (!history.ok) {
      process.stderr.write(formatConfigErrors(history.errors));

      return configErrorExitCode();
    }

    return runHistoryCommand(command, history.config, io);
  }

  const result = loadConfig(env, { command: command.kind });

  if (!result.ok) {
    process.stderr.write(formatConfigErrors(result.errors));

    return configErrorExitCode();
  }

  switch (command.kind) {
    case 'check':
      return runCheckCommand(command, result.config, io);
    case 'provision':
      return runProvisionCommand(command, result.config, io);
    case 'run':
      return runRunCommand(command, result.config, io);
    default:
      return serve(result.config, result.env);
  }
}

process.exitCode = await main(process.argv.slice(2), process.env);
