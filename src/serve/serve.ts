import { hostname as osHostname } from 'node:os';
import process from 'node:process';
import { createAlerter } from '../alerting/alerter.js';
import type { sendNotify } from '../alerting/notify.js';
import { startApp, StartupError } from '../app.js';
import { createCollectorClient } from '../clients/collector.js';
import type { CollectorClient } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import { notificationSettings } from '../config/load.js';
import type { Config } from '../config/load.js';
import { createMutableRedactor, redactDeep } from '../errors/redact.js';
import type { MutableRedactor } from '../errors/redact.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import type { Check } from '../http/internal-server.js';
import { serializeError } from '../log/logger.js';
import type { LogFields, Logger } from '../log/logger.js';
import { probeReceiver, resolvePublicAddress } from '../notifications/address.js';
import type { PublicAddress } from '../notifications/address.js';
import { createProvisioner } from '../notifications/provisioning.js';
import type { Provisioner } from '../notifications/provisioning.js';
import { startReceiver } from '../receiver/server.js';
import type { Receiver } from '../receiver/server.js';
import { runCheckNotification } from '../scenarios/check-notification/run.js';
import type { LastHostname } from '../scenarios/check-notification/stages.js';
import { runSendAndReceive, scenarioSecrets } from '../scenarios/send-and-receive/run.js';
import { createScheduler } from '../scheduler/scheduler.js';
import type { ScenarioRunner, Scheduler } from '../scheduler/scheduler.js';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import type { History } from '../storage/history.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';
import { LEASE_REFRESH_MS, liveLease, releaseLease, writeLease } from '../storage/lease.js';
import { projectedEventsPer30Days } from '../storage/outcome.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { createRoutes } from './routes.js';

const MS_PER_DAY = 86_400_000;
const TUNNEL_POLL_MS = 2000;
const ALERT_BACKLOG_LIMIT_MS = 1_800_000;
const NOTIFY_TOKEN_MARKER = '/u/';

/** Test hooks and replacements for the parts of `serve` that talk to the outside. */
export interface ServeOverrides {
  /** Hawk API client shared by all runs. */
  api?: HawkApi;
  /** Collector client shared by all runs. */
  collector?: CollectorClient;
  /** Replaces the call to codex.bot. */
  send?: typeof sendNotify;
  /** Replaces the lookup of the public address. */
  resolveAddress?: typeof resolvePublicAddress;
  /** Poll schedule of the search for the event, short in tests. */
  pollScheduleMs?: readonly number[];
  /** Pauses between attempts of address calls, short in tests. */
  retryDelaysMs?: readonly number[];
  /** Pause between self-checks while a new tunnel address is awaited, 2000 ms by default. */
  addressPollMs?: number;
  /** Pause between self-checks while the tunnel starts, 2000 ms by default. */
  tunnelPollMs?: number;
}

/** Who runs this `serve`, for its lease. */
export interface ProcessIdentity {
  /** Host name of the machine or container. */
  hostname: string;
  /** Process id. */
  pid: number;
}

/** What `startServe` needs. */
export interface ServeDeps {
  /** Validated configuration. */
  config: Config;
  /** Logger of the process; secrets are masked before lines reach it. */
  logger: Logger;
  /** Time source and sleeper; the system clock by default. */
  clock?: Clock;
  /** Ends the process; used after hung runs. Exits the process by default. */
  exit?: (code: number) => void;
  /** Host and process id for the lease; the real ones by default. */
  identity?: ProcessIdentity;
  /** Replacements for tests. */
  overrides?: ServeOverrides;
}

/** A running `serve`. */
export interface ServeHandle {
  /** Port of the internal server. */
  port: number;
  /** Port of the receiver, when the notification scenario is on. */
  receiverPort?: number;
  /** The scheduler. */
  scheduler: Scheduler;
  /**
   * Stops everything and gives up the lease; repeated calls return the same promise.
   * @returns Resolves when the process can exit.
   */
  stop(): Promise<void>;
}

/**
 * Builds the pattern that finds the run id in the title of an event of one instance.
 * @param instanceId Id of the instance; its characters are matched literally.
 * @returns Pattern with the run id as its first group.
 */
export function LATE_RUN_ID(instanceId: string): RegExp {
  return new RegExp(`\\[e2e:${instanceId.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}\\] ([a-z]{16}) `, 'u');
}

/**
 * Wraps a logger so that every line passes the redactor first.
 * @param logger Logger to wrap.
 * @param masking Redactor that knows the secrets.
 * @returns Logger that masks messages and fields, errors included.
 */
function maskedLogger(logger: Logger, masking: MutableRedactor): Logger {
  const mask = (fields: LogFields | undefined): LogFields | undefined => {
    if (fields === undefined) {
      return undefined;
    }

    return redactDeep(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serializeError(value)])), masking.redact);
  };

  return {
    debug: (msg, fields) => {
      logger.debug(masking.redact(msg), mask(fields));
    },
    info: (msg, fields) => {
      logger.info(masking.redact(msg), mask(fields));
    },
    warn: (msg, fields) => {
      logger.warn(masking.redact(msg), mask(fields));
    },
    error: (msg, fields) => {
      logger.error(masking.redact(msg), mask(fields));
    },
  };
}

/**
 * Collects what must never reach a log or a message: the secrets of the scenarios and the notify address with its token.
 * @param config Validated configuration.
 * @returns Redactor that learns more secrets while the process runs.
 */
function createMasking(config: Config): MutableRedactor {
  const secrets = scenarioSecrets(config);
  const url = config.monitoring.alertNotifyUrl;

  if (url !== undefined) {
    secrets.push(url);

    const token = url.includes(NOTIFY_TOKEN_MARKER) ? url.slice(url.indexOf(NOTIFY_TOKEN_MARKER) + NOTIFY_TOKEN_MARKER.length) : '';

    if (token !== '') {
      secrets.push(token);
    }
  }

  return createMutableRedactor(secrets);
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

/** The clients of Hawk that all runs of a process share. */
interface HawkClients {
  /** Hawk API client. */
  api: HawkApi;
  /** Collector client. */
  collector: CollectorClient;
}

/**
 * Builds the clients of Hawk for the whole process.
 * @param config Validated configuration with the URLs and credentials.
 * @param clock Clock the clients wait with.
 * @returns API and collector clients.
 */
function createClients(config: Config, clock: Clock): HawkClients {
  const token = decodeIntegrationToken(config.hawk.integrationToken);

  if (token === undefined) {
    throw new Error('HAWK_INTEGRATION_TOKEN does not decode, although the configuration was validated');
  }

  return {
    collector: createCollectorClient({ endpoints: collectorEndpoints(token, config.hawk.collectorUrl),
      httpTimeoutMs: config.httpTimeoutMs,
      clock }),
    api: createHawkApi({ transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock }),
  };
}

/**
 * Runs `action` every `periodMs` until the signal aborts; a failure is logged and the loop goes on.
 * @param clock Sleeper.
 * @param periodMs Pause between runs.
 * @param signal Stops the loop.
 * @param action What to do.
 * @param onError Called with a failure of `action`.
 * @returns Resolves when the loop ended.
 */
async function every(clock: Clock, periodMs: number, signal: AbortSignal, action: () => void, onError: (error: unknown) => void): Promise<void> {
  for (;;) {
    try {
      await clock.sleep(periodMs, signal);
    } catch {
      return;
    }

    try {
      action();
    } catch (error) {
      onError(error);
    }
  }
}

/**
 * Opens the history and names the file when that fails.
 * @param config Validated configuration.
 * @returns History over the opened database.
 * @throws StartupError with the path and the reason.
 */
function openHistory(config: Config): History {
  const path = config.monitoring.databasePath;

  try {
    return createHistory(openDatabase(path));
  } catch (error) {
    throw new StartupError(`Cannot open DATABASE_PATH ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Runs the closers from the last to the first; a failing closer is logged and does not stop the others.
 * @param closers Closers in the order the parts were started.
 * @param logger Logger for failures.
 * @returns Resolves when all ran.
 */
async function closeAll(closers: Closer[], logger: Logger): Promise<void> {
  for (const close of closers.splice(0).toReversed()) {
    try {
      await close();
    } catch (error) {
      logger.error('stopping failed', { error });
    }
  }
}

/** Something to stop when the service stops. */
type Closer = () => Promise<void> | void;

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
  /** Pauses between attempts of address calls. */
  retryDelaysMs?: readonly number[];
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
        ...wait.retryDelaysMs === undefined ? {} : { retryDelaysMs: wait.retryDelaysMs } }, signal);
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
 * Starts the service: history, lease, receiver, alerts, scheduler and the internal server with its routes.
 * @param deps Configuration, logger and optional replacements.
 * @returns Handle with the ports, the scheduler and `stop`.
 * @throws StartupError when the database cannot be opened, another `serve` holds it, or a port is taken.
 */
export async function startServe(deps: ServeDeps): Promise<ServeHandle> {
  const { config } = deps;
  const { monitoring } = config;
  const clock = deps.clock ?? systemClock;
  const overrides = deps.overrides ?? {};
  const identity = deps.identity ?? { hostname: osHostname(),
    pid: process.pid };
  const masking = createMasking(config);
  const logger = maskedLogger(deps.logger, masking);
  const exit = deps.exit ?? ((code: number): void => {
    // eslint-disable-next-line n/no-process-exit -- a stuck scheduler cannot recover in place, so end the process and let the container restart it
    process.exit(code);
  });
  const background = new AbortController();
  const closers: Closer[] = [];
  const retry = overrides.retryDelaysMs === undefined ? {} : { retryDelaysMs: overrides.retryDelaysMs };

  const history = openHistory(config);

  closers.push(() => {
    history.close();
  });

  try {
    const now = clock.wallTime();
    const lease = liveLease(history, now);

    if (lease !== undefined && (lease.hostname !== identity.hostname || lease.pid !== identity.pid)) {
      throw new StartupError(`Another serve (pid ${String(lease.pid)}) is running for DATABASE_PATH ${monitoring.databasePath}`);
    }

    const aborted = history.abortRunning('monitor_restarted', now.toISOString());

    if (aborted > 0) {
      logger.warn('runs of an earlier process were still marked running', { aborted });
    }

    history.prune(new Date(now.getTime() - monitoring.retentionDays * MS_PER_DAY).toISOString());

    const renew = (): void => {
      writeLease(history, { pid: identity.pid,
        hostname: identity.hostname,
        at: clock.wallTime().toISOString() });
    };

    renew();

    const workers: Array<Promise<void>> = [
      every(clock, LEASE_REFRESH_MS, background.signal, renew, (error) => {
        logger.error('could not renew the lease', { error });
      }),
      every(clock, MS_PER_DAY, background.signal, () => {
        history.prune(new Date(clock.wallTime().getTime() - monitoring.retentionDays * MS_PER_DAY).toISOString());
      }, (error) => {
        logger.error('could not prune the history', { error });
      }),
    ];

    closers.push(async () => {
      background.abort();
      await Promise.all(workers);
      releaseLease(history);
    });

    const clients = createClients(config, clock);
    const api = overrides.api ?? clients.api;
    const collector = overrides.collector ?? clients.collector;
    const alerter = createAlerter({ history,
      logger,
      clock,
      redact: masking.redact,
      config,
      ...overrides.send === undefined ? {} : { send: overrides.send } });

    alerter.start();
    closers.push(async () => alerter.stop());

    const notifies = monitoring.scenarios.includes('check-notification');
    const runners: Partial<Record<'check-notification' | 'send-and-receive-event', ScenarioRunner>> = {};
    const beforeFirstRun: Partial<Record<'check-notification', (signal: AbortSignal) => Promise<void>>> = {};
    let receiver: Receiver | undefined;
    let receiverClosed = false;

    const base = { config,
      collector,
      api,
      clock,
      logger,
      redact: masking.redact,
      ...overrides.pollScheduleMs === undefined ? {} : { pollScheduleMs: overrides.pollScheduleMs } };

    runners['send-and-receive-event'] = async ({ runId, sequence, signal }) => runSendAndReceive({ ...base,
      signal }, { sequence,
      runId });

    if (notifies) {
      const settings = notificationSettings(config);

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

      closers.push(async () => {
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
        ...retry }, signal);
      const lastHostname: LastHostname = {};

      runners['check-notification'] = async ({ runId, sequence, signal }) => runCheckNotification({ ...base,
        signal,
        receiver: started,
        provisioner,
        resolveAddress: findAddress,
        addSecret: masking.add,
        lastHostname,
        ...retry,
        ...overrides.addressPollMs === undefined ? {} : { addressPollMs: overrides.addressPollMs } }, { sequence,
        runId });

      beforeFirstRun['check-notification'] = async (signal) => {
        await waitForTunnel({ findAddress,
          receiver: started,
          secret: settings.receiverSecret,
          config,
          clock,
          logger,
          masking,
          signal,
          pollMs: overrides.tunnelPollMs ?? TUNNEL_POLL_MS,
          ...retry });
      };
    }

    const scheduler = createScheduler({ runners,
      history,
      clock,
      logger,
      config,
      redact: masking.redact,
      beforeFirstRun,
      onRunFinished: [(row, result) => {
        alerter.onRunFinished(row, result);
      }],
      projectedEventsPer30Days: projectedEventsPer30Days(config),
      exit });
    const liveness: Check[] = [
      { name: 'scheduler',
        run: async () => Promise.resolve(scheduler.health().scheduler) },
      { name: 'storage',
        run: async () => Promise.resolve(scheduler.health().storage && !alerter.health().storageFailing) },
    ];
    const readiness: Check[] = [
      { name: 'history',
        run: async () => {
          history.getKv('serve_lease');

          return Promise.resolve(true);
        } },
      ...receiver === undefined
        ? []
        : [{ name: 'receiver',
            run: async () => Promise.resolve(!receiverClosed) }],
      { name: 'alerts',
        run: async () => {
          const age = alerter.health().backlogAgeMs;

          return Promise.resolve(age === null || age <= ALERT_BACKLOG_LIMIT_MS);
        } },
    ];
    const app = await startApp(config, { logger,
      liveness,
      readiness,
      routes: createRoutes({ history,
        config,
        clock,
        scheduler,
        alerter,
        sweepFailures: () => 0 }) });

    closers.push(async () => app.stop());
    closers.push(async () => scheduler.stop());
    scheduler.start();
    logger.info('serve started', { scenarios: monitoring.scenarios,
      intervalMs: monitoring.intervalMs,
      databasePath: monitoring.databasePath });

    let stopPromise: Promise<void> | undefined;

    return {
      port: app.port,
      ...receiver === undefined ? {} : { receiverPort: receiver.port },
      scheduler,
      stop: () => {
        stopPromise ??= closeAll(closers, logger);

        return stopPromise;
      },
    };
  } catch (error) {
    await closeAll(closers, logger);
    throw error;
  }
}
