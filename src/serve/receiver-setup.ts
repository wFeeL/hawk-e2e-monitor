import { StartupError } from '../app.js';
import { ConfigFailure, formatConfigErrors, notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import type { MutableRedactor } from '../errors/redact.js';
import type { Check } from '../http/internal-server.js';
import type { Logger } from '../log/logger.js';
import { probeReceiver, resolvePublicAddress } from '../notifications/address.js';
import type { PublicAddress } from '../notifications/address.js';
import { startReceiver } from '../receiver/server.js';
import type { Receiver } from '../receiver/server.js';
import type { LastHostname } from '../scenarios/check-notification/stages.js';
import type { Clock } from '../time/clock.js';
import type { FindAddress, RunnerContext } from './scenario-setup.js';

const TUNNEL_POLL_MS = 2000;

/**
 * Builds the pattern that finds the run id in the title of an event of one instance.
 * @param instanceId Id of the instance; its characters are matched literally.
 * @returns Pattern with the run id as its first group.
 */
export function LATE_RUN_ID(instanceId: string): RegExp {
  return new RegExp(`\\[e2e:${instanceId.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}\\] ([a-z]{16}) `, 'u');
}

/**
 * Turns a failed `listen` of the receiver into a message for the operator.
 * @param error Error of `startReceiver`.
 * @param config Configuration with the receiver address.
 * @returns Startup error.
 */
function receiverError(error: unknown, config: Config): StartupError {
  const { receiverHost, receiverPort } = config.notifications;
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  const reason = code === 'EADDRINUSE'
    ? `RECEIVER_PORT ${String(receiverPort)} is already in use on ${receiverHost}`
    : `Cannot listen on ${receiverHost}:${String(receiverPort)}: ${error instanceof Error ? error.message : 'unknown error'}`;

  return new StartupError(reason, { cause: error });
}

/**
 * Reads the notification settings, which only a chosen check-notification needs.
 * @param config Configuration to read.
 * @returns The settings with the secret present.
 * @throws StartupError naming the missing variables.
 */
function settingsOrStartupError(config: Config): ReturnType<typeof notificationSettings> {
  try {
    return notificationSettings(config);
  } catch (error) {
    if (error instanceof ConfigFailure) {
      throw new StartupError(formatConfigErrors(error.errors).trimEnd(), { cause: error });
    }

    throw error;
  }
}

/** What the wait for the tunnel needs. */
interface TunnelWait {
  /** Looks up the public address. */
  findAddress: (signal: AbortSignal) => Promise<PublicAddress>;
  /** Receiver whose nonce the self-check expects. */
  receiver: Receiver;
  /** Secret of the receiver paths. */
  secret: string;
  /** Configuration with the limits. */
  config: Config;
  /** Clock. */
  clock: Clock;
  /** Logger. */
  logger: Logger;
  /** Redactor that learns the address. */
  masking: MutableRedactor;
  /** Cancels the wait. */
  signal: AbortSignal;
  /** Pause between tries. */
  pollMs: number;
}

/**
 * Waits until the tunnel has an address and the receiver answers through it, for at most `TUNNEL_READY_TIMEOUT_MS`.
 * Running on without the tunnel is fine: the run then fails in `notification_setup` with its own class.
 * @param wait What the wait needs.
 * @returns Resolves when the tunnel is ready, the time is up or the signal aborts; never rejects.
 */
async function waitForTunnel(wait: TunnelWait): Promise<void> {
  const { config, clock, logger, signal } = wait;
  const limitMs = config.monitoring.tunnelReadyTimeoutMs;
  const startedMs = clock.monotonicMs();

  if (limitMs === 0) {
    return;
  }

  for (;;) {
    try {
      const address = await wait.findAddress(signal);

      wait.masking.add(address.baseUrl);
      wait.masking.add(address.hostname);
      await probeReceiver(address, wait.secret, wait.receiver.nonce, { httpTimeoutMs: config.httpTimeoutMs,
        clock,
        attempts: 1,
        retry: config.retry }, signal);
      logger.info('tunnel is ready');

      return;
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      if (clock.monotonicMs() - startedMs + wait.pollMs > limitMs) {
        logger.warn('the tunnel was not ready in time; the first run goes on without it', { error,
          waitedMs: Math.round(clock.monotonicMs() - startedMs) });

        return;
      }
    }

    try {
      await clock.sleep(wait.pollMs, signal);
    } catch {
      return;
    }
  }
}

/** What the notification scenarios of one process share: one receiver, one way to find the address, one wait for the tunnel. */
export interface ReceiverRuntime {
  /** Notification settings with the receiver secret present. */
  settings: ReturnType<typeof notificationSettings>;
  /** The running receiver. */
  receiver: Receiver;
  /** Looks up the public address. */
  findAddress: FindAddress;
  /** Host of the address of the previous run; both scenarios see the same address, so they share it. */
  lastHostname: LastHostname;
  /** Waits for the tunnel once for the process, later callers get the same wait; never rejects, and a signal that aborts ends the wait of the first caller. */
  waitForTunnel: (signal: AbortSignal) => Promise<void>;
  /** Readiness check of the receiver. */
  readiness: Check[];
}

/**
 * Starts the receiver and builds what the notification scenarios share.
 * @param context Configuration, history, clock and clients of the process.
 * @returns The receiver, the address lookup and the wait for the tunnel, ready to share.
 */
async function startRuntime(context: RunnerContext): Promise<ReceiverRuntime> {
  const { config, history, clock, logger, masking, overrides } = context;
  const settings = settingsOrStartupError(config);
  let receiver: Receiver;

  try {
    receiver = await startReceiver({ host: settings.receiverHost,
      port: settings.receiverPort,
      secret: settings.receiverSecret,
      clock,
      logger,
      onUnmatched: (channel, rawBody) => {
        const found = LATE_RUN_ID(config.instanceId).exec(rawBody);
        const runId = found?.[1];
        // The history keeps a late notification of the channels of the rules; a late threshold POST is only logged.
        const outcome = runId === undefined || channel === 'threshold' ? undefined : history.markLateNotification(runId, channel, clock.wallTime().toISOString());

        logger.info('late notification', { channel,
          runId,
          result: outcome ?? (runId === undefined ? 'not of this instance' : channel === 'threshold' ? 'threshold POST is not recorded' : 'unknown run or already counted') });
      } });
  } catch (error) {
    throw receiverError(error, config);
  }

  const started = receiver;
  let receiverClosed = false;

  context.closers.push(async () => {
    receiverClosed = true;
    await started.close();
  });

  const resolve = overrides.resolveAddress ?? resolvePublicAddress;
  const findAddress: FindAddress = async signal => resolve(settings, { httpTimeoutMs: config.httpTimeoutMs,
    clock,
    retry: config.retry }, signal);
  let tunnel: Promise<void> | undefined;

  return {
    settings,
    receiver: started,
    findAddress,
    lastHostname: {},
    waitForTunnel: async (signal) => {
      tunnel ??= waitForTunnel({ findAddress,
        receiver: started,
        secret: settings.receiverSecret,
        config,
        clock,
        logger,
        masking,
        signal,
        pollMs: overrides.tunnelPollMs ?? TUNNEL_POLL_MS });

      return tunnel;
    },
    readiness: [{ name: 'receiver',
      run: async () => Promise.resolve(!receiverClosed) }],
  };
}

/** What a provisioner needs to keep its warmup across restarts. */
export interface MatchChangeOptions {
  /** Wall-clock time of the last change an earlier process stored. */
  lastMatchChangeAtWallMs?: number;
  /** Stores the wall-clock time of a change. */
  onMatchChange: (wallMs: number) => void;
}

/**
 * Starts the receiver of the process, or returns the one an earlier setup started.
 * The receiver, its closer, the late-notification handler and the address lookup exist once, whichever notification scenarios are chosen.
 * @param context Everything a scenario needs to be set up; the runtime is remembered on it.
 * @returns The shared runtime.
 * @throws StartupError when the settings are missing or the receiver cannot listen.
 */
export async function sharedReceiver(context: RunnerContext): Promise<ReceiverRuntime> {
  context.receiverRuntime ??= startRuntime(context);

  return context.receiverRuntime;
}

/**
 * Builds the options that keep a provisioner's warmup across restarts.
 * @param context Everything a scenario needs to be set up.
 * @param key Key in the history that holds the time of the last change of this rule.
 * @returns The stored time, when there is one, and the function that stores a new one.
 */
export function matchChangeOptions(context: RunnerContext, key: string): MatchChangeOptions {
  const { history, logger } = context;
  const stored = Date.parse(history.getKv(key) ?? '');

  return {
    ...Number.isNaN(stored) ? {} : { lastMatchChangeAtWallMs: stored },
    onMatchChange: (wallMs) => {
      try {
        history.setKv(key, new Date(wallMs).toISOString());
      } catch (error) {
        logger.error('could not store the time of the rule change', { error });
      }
    },
  };
}
