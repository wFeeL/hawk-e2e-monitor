import { StartupError } from '../app.js';
import { notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import type { MutableRedactor } from '../errors/redact.js';
import type { Logger } from '../log/logger.js';
import { probeReceiver, resolvePublicAddress } from '../notifications/address.js';
import type { PublicAddress } from '../notifications/address.js';
import { createProvisioner } from '../notifications/provisioning.js';
import type { Provisioner } from '../notifications/provisioning.js';
import { startReceiver } from '../receiver/server.js';
import type { Receiver } from '../receiver/server.js';
import { runCheckNotification } from '../scenarios/check-notification/run.js';
import type { LastHostname } from '../scenarios/check-notification/stages.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';
import type { Clock } from '../time/clock.js';
import type { ScenarioSetup, SetupScenario } from './scenario-setup.js';

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

/**
 * Starts the receiver and builds the runner of `check-notification` around it.
 * @param context Everything a scenario needs to be set up.
 * @returns Runner, the wait for the tunnel and the readiness check of the receiver.
 * @throws StartupError when the receiver cannot listen.
 */
export const setupCheckNotification: SetupScenario = async (context): Promise<ScenarioSetup> => {
  const { config, history, clock, logger, masking, api, collector, overrides } = context;
  const settings = notificationSettings(config);
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
        const outcome = runId === undefined ? undefined : history.markLateNotification(runId, channel, clock.wallTime().toISOString());

        logger.info('late notification', { channel,
          runId,
          result: outcome ?? (runId === undefined ? 'not of this instance' : 'unknown run or already counted') });
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

  const stored = Date.parse(history.getKv(MATCH_CHANGED_KEY) ?? '');
  const provisioner: Provisioner = createProvisioner({ api,
    clock,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    secret: settings.receiverSecret,
    loop: settings.loop,
    warmupMs: settings.ruleCacheWarmupMs,
    ...Number.isNaN(stored) ? {} : { lastMatchChangeAtWallMs: stored },
    onMatchChange: (wallMs) => {
      try {
        history.setKv(MATCH_CHANGED_KEY, new Date(wallMs).toISOString());
      } catch (error) {
        logger.error('could not store the time of the rule change', { error });
      }
    } });
  const resolve = overrides.resolveAddress ?? resolvePublicAddress;
  const findAddress = async (signal: AbortSignal): Promise<PublicAddress> => resolve(settings, { httpTimeoutMs: config.httpTimeoutMs,
    clock,
    retry: config.retry }, signal);
  const lastHostname: LastHostname = {};

  return {
    runner: async ({ runId, sequence, signal }) => runCheckNotification({ config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs },
      signal,
      receiver: started,
      provisioner,
      resolveAddress: findAddress,
      addSecret: masking.add,
      lastHostname,
      ...overrides.addressPollMs === undefined ? {} : { addressPollMs: overrides.addressPollMs } }, { sequence,
      runId }),
    beforeFirstRun: async (signal) => {
      await waitForTunnel({ findAddress,
        receiver: started,
        secret: settings.receiverSecret,
        config,
        clock,
        logger,
        masking,
        signal,
        pollMs: overrides.tunnelPollMs ?? TUNNEL_POLL_MS });
    },
    readiness: [{ name: 'receiver',
      run: async () => Promise.resolve(!receiverClosed) }],
    receiverPort: started.port,
  };
};
