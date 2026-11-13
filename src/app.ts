import type { AddressInfo } from 'node:net';
import type { Config } from './config/load.js';
import { createInternalServer } from './http/internal-server.js';
import type { Check } from './http/internal-server.js';
import type { Logger } from './log/logger.js';

/** Dependencies injected into `startApp`. */
export interface AppDeps {
  /** Logger for the whole service. */
  logger: Logger;
  /** Checks behind `/healthz`; none by default. */
  liveness?: readonly Check[];
  /** Checks behind `/readyz`; none by default. */
  readiness?: readonly Check[];
}

/** A running service. */
export interface AppHandle {
  /** Port the internal server listens on. */
  port: number;
  /**
   * Stops the service; repeated calls return the same promise.
   * @returns Promise settled when the server is closed.
   */
  stop(): Promise<void>;
}

/** Startup failure whose message is written for the operator. */
export class StartupError extends Error {}

/**
 * Turns a `listen` error into a message naming the variable to fix.
 * @param error Error emitted before `listening`.
 * @param host Requested host.
 * @param port Requested port.
 * @returns Startup error with the original error as `cause`.
 */
function listenError(error: unknown, host: string, port: number): StartupError {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  let message: string;

  if (code === 'EADDRINUSE') {
    message = `INTERNAL_PORT ${String(port)} is already in use on ${host}`;
  } else if (code === 'EACCES') {
    message = `INTERNAL_PORT ${String(port)} requires elevated privileges`;
  } else if (code === 'EADDRNOTAVAIL') {
    message = `INTERNAL_HOST ${host} is not an address of this machine`;
  } else {
    message = `Cannot listen on ${host}:${String(port)}: ${error instanceof Error ? error.message : 'unknown error'}`;
  }

  return new StartupError(message, { cause: error });
}

/**
 * Starts the internal HTTP server.
 * @param config Validated configuration.
 * @param deps Logger and optional checks.
 * @returns Handle with the bound port and an idempotent `stop`.
 */
export async function startApp(config: Config, deps: AppDeps): Promise<AppHandle> {
  const server = createInternalServer({
    logger: deps.logger,
    liveness: deps.liveness ?? [],
    readiness: deps.readiness ?? [],
    checkTimeoutMs: config.healthCheckTimeoutMs,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      reject(listenError(error, config.internal.host, config.internal.port));
    };

    server.once('error', onError);
    server.listen(config.internal.port, config.internal.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  let stopPromise: Promise<void> | undefined;

  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      stopPromise ??= new Promise<void>((resolve, reject) => {
        // Connections still busy after the budget are cut so shutdown ends.
        const timer = setTimeout(() => {
          server.closeAllConnections();
        }, config.shutdownTimeoutMs);

        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
        server.closeIdleConnections();
      });

      return stopPromise;
    },
  };
}
