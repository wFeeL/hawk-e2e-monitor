import process from 'node:process';
import { startApp, StartupError } from './app.js';
import type { AppHandle } from './app.js';
import { parseCommand } from './cli.js';
import { runCheckCommand } from './commands/check.js';
import { runProvisionCommand } from './commands/provision.js';
import type { Config } from './config/load.js';
import { formatConfigErrors, loadConfig } from './config/load.js';
import { describeConfig } from './config/describe.js';
import type { ParsedEnv } from './config/schema.js';
import { createLogger } from './log/logger.js';
import { SERVICE_VERSION } from './version.js';

const STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Starts the service and wires process-level error and signal handling.
 * Fatal error policy: see docs/architecture.md.
 * @param config Validated configuration.
 * @param env Parsed variables for the startup summary.
 */
async function serve(config: Config, env: ParsedEnv): Promise<void> {
  const logger = createLogger({ level: config.logLevel });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { error: reason });
    // eslint-disable-next-line n/no-process-exit -- fatal error policy, see docs/architecture.md
    process.exit(1);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('uncaught exception', { error });
    // eslint-disable-next-line n/no-process-exit -- fatal error policy, see docs/architecture.md
    process.exit(1);
  });

  const summary = describeConfig(env);

  logger.info('starting', { version: SERVICE_VERSION,
    config: summary.values });
  for (const warning of summary.warnings) {
    logger.warn(warning);
  }

  let app: AppHandle | undefined;
  let stopRequested = false;
  let pendingSignal = '';

  const shutdown = (): void => {
    app?.stop().then(() => {
      logger.info('stopped');
      // eslint-disable-next-line n/no-process-exit -- fatal error policy, see docs/architecture.md
      process.exit(0);
    }, (error: unknown) => {
      logger.error('stop failed', { error });
      // eslint-disable-next-line n/no-process-exit -- fatal error policy, see docs/architecture.md
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
      } else {
        logger.info('stopping', { signal });
        shutdown();
      }
    });
  }

  try {
    app = await startApp(config, { logger });
  } catch (error: unknown) {
    if (!(error instanceof StartupError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    logger.error('startup failed', { error });
    process.exitCode = 1;

    return;
  }

  logger.info('listening', { host: config.internal.host,
    port: app.port });

  if (stopRequested) {
    logger.info('stopping', { signal: pendingSignal,
      after: 'startup' });
    shutdown();
  }
}

const command = parseCommand(process.argv.slice(2));

if (command.kind === 'usage') {
  process.stderr.write(command.message);
  process.exitCode = 2;
} else {
  const result = loadConfig(process.env);

  if (!result.ok) {
    process.stderr.write(formatConfigErrors(result.errors));
    process.exitCode = 1;
  } else if (command.kind === 'check') {
    process.exitCode = await runCheckCommand(command, result.config, {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    });
  } else if (command.kind === 'provision') {
    process.exitCode = await runProvisionCommand(command, result.config, {
      stdout: (text) => {
        process.stdout.write(text);
      },
      stderr: (text) => {
        process.stderr.write(text);
      },
    });
  } else {
    await serve(result.config, result.env);
  }
}
