import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import process from 'node:process';
import { ALERT_BACKLOG_LIMIT_MS, createAlerter } from '../alerting/alerter.js';
import { createSweeper } from '../cleanup/sweep.js';
import type { sendNotify } from '../alerting/notify.js';
import { startApp, StartupError } from '../app.js';
import { createCollectorClient } from '../clients/collector.js';
import type { CollectorClient } from '../clients/collector.js';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import type { Config } from '../config/load.js';
import { redactDeep } from '../errors/redact.js';
import type { MutableRedactor } from '../errors/redact.js';
import { collectorEndpoints, decodeIntegrationToken } from '../hawk/token.js';
import type { Check } from '../http/internal-server.js';
import { serializeError } from '../log/logger.js';
import type { LogFields, Logger } from '../log/logger.js';
import { createScheduler } from '../scheduler/scheduler.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import type { History } from '../storage/history.js';
import { claimLease, LEASE_REFRESH_MS, LEASE_TWIN_MARGIN_MS, releaseLease } from '../storage/lease.js';
import type { Lease } from '../storage/lease.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import { scenarioSettings } from '../config/scenario.js';
import { SCENARIO_NAMES } from '../scenarios/names.js';
import { createMetrics } from '../metrics/metrics.js';
import { SERVICE_VERSION } from '../version.js';
import { createServeHeartbeat } from './heartbeat-setup.js';
import { leaseRenewer } from './lease-keeper.js';
import { createMasking } from './masking.js';
import { createRoutes } from './routes.js';
import { buildRunners } from './runners.js';
import type { Closer, RunnerOverrides } from './scenario-setup.js';
import { every } from '../time/every.js';
import { MS_PER_DAY, MS_PER_SECOND } from '../time/units.js';

const ALERT_BACKLOG_METRIC_MS = 15_000;

/** Test hooks and replacements for the parts of `serve` that talk to the outside. */
export interface ServeOverrides extends RunnerOverrides {
  /** Hawk API client shared by all runs. */
  api?: HawkApi;
  /** Collector client shared by all runs. */
  collector?: CollectorClient;
  /** Replaces the call to codex.bot. */
  send?: typeof sendNotify;
  /** Wait before the first sweep of leftover events, 5 minutes by default. */
  sweepFirstDelayMs?: number;
}

/** Who runs this `serve`, for its lease. */
export interface ProcessIdentity {
  /** Random value of this start; a new one by default. */
  nonce?: string;
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
  /** Aborts the start, for a stop signal that comes while `startServe` waits for the lease of an earlier process. */
  signal?: AbortSignal;
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

  const debug: Logger['debug'] = (msg, fields) => {
    logger.debug(masking.redact(msg), mask(fields));
  };

  const info: Logger['info'] = (msg, fields) => {
    logger.info(masking.redact(msg), mask(fields));
  };

  const warn: Logger['warn'] = (msg, fields) => {
    logger.warn(masking.redact(msg), mask(fields));
  };

  const error: Logger['error'] = (msg, fields) => {
    logger.error(masking.redact(msg), mask(fields));
  };

  return {
    debug,
    info,
    warn,
    error,
  };
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
      clock,
      retry: config.retry }),
    api: createHawkApi({ transport: createGraphqlTransport({ url: config.hawk.apiUrl,
      httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retry: config.retry }),
    email: config.hawk.email,
    password: config.hawk.password,
    clock,
    retry: config.retry }),
  };
}

/**
 * Deletes the runs and delivered alerts that are older than the retention of their scenario.
 * @param history Store whose old rows go.
 * @param config Validated configuration with the retention of each scenario.
 * @param now Current time; the cutoff of a scenario is its retention before it.
 */
function pruneHistory(history: History, config: Config, now: Date): void {
  for (const scenario of SCENARIO_NAMES) {
    history.prune(new Date(now.getTime() - scenarioSettings(config, scenario).retentionDays * MS_PER_DAY).toISOString(), { scenario });
  }

  // Rows of a scenario that was removed or renamed belong to no list above, so they expire with the global retention.
  history.prune(new Date(now.getTime() - config.monitoring.retentionDays * MS_PER_DAY).toISOString(), { exceptScenarios: SCENARIO_NAMES });
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
  const identity = { hostname: osHostname(),
    pid: process.pid,
    nonce: randomUUID(),
    ...deps.identity };
  const masking = createMasking(config);
  const logger = maskedLogger(deps.logger, masking);
  const exit = deps.exit ?? ((code: number): void => {
    // eslint-disable-next-line n/no-process-exit -- a stuck scheduler cannot recover in place, so end the process and let the container restart it
    process.exit(code);
  });
  const background = new AbortController();
  const closers: Closer[] = [];

  const history = openHistory(config);

  closers.push(() => {
    history.close();
  });

  try {
    let now = clock.wallTime();
    const ownLease = (): Lease => ({ pid: identity.pid,
      hostname: identity.hostname,
      nonce: identity.nonce,
      at: clock.wallTime().toISOString() });
    let claim = claimLease(history, ownLease(), now);

    if (claim.kind === 'twin') {
      // After a container restart the predecessor has the same pid and host name; a live twin renews within one period.
      logger.warn('a lease with the same pid and hostname exists; waiting one renewal period', { pid: claim.lease.pid });

      try {
        await clock.sleep(LEASE_REFRESH_MS + LEASE_TWIN_MARGIN_MS, deps.signal === undefined ? background.signal : AbortSignal.any([background.signal, deps.signal]));
      } catch (error) {
        throw new StartupError('stopped while waiting for the lease of an earlier process', { cause: error });
      }

      // The wait took a renewal period, so the earlier reading would date the aborted runs and the pruning too early.
      now = clock.wallTime();
      claim = claimLease(history, ownLease(), now, { staleAt: claim.lease.at });
    }

    if (claim.kind !== 'claimed') {
      throw new StartupError(`Another serve (pid ${String(claim.lease.pid)}) is running for DATABASE_PATH ${monitoring.databasePath}`);
    }

    const aborted = history.abortRunning('monitor_restarted', now.toISOString());

    if (aborted.length > 0) {
      logger.warn('runs of an earlier process were still marked running', { aborted: aborted.length });
    }

    pruneHistory(history, config, now);

    const renew = leaseRenewer({ history,
      lease: ownLease,
      logger,
      exit,
      databasePath: monitoring.databasePath });

    const workers: Array<Promise<void>> = [
      every(clock, LEASE_REFRESH_MS, background.signal, renew, (error) => {
        logger.error('could not renew the lease', { error });
      }),
      every(clock, MS_PER_DAY, background.signal, () => {
        pruneHistory(history, config, clock.wallTime());
      }, (error) => {
        logger.error('could not prune the history', { error });
      }),
    ];

    closers.push(async () => {
      background.abort();
      await Promise.all(workers);
      releaseLease(history, ownLease());
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

    const metrics = createMetrics({ version: SERVICE_VERSION,
      logger });

    closers.push(() => {
      metrics.stop();
    });

    for (const row of aborted) {
      // The alerter ignores a restart of the monitor, so only the metrics hear of these rows.
      metrics.onRunFinished(row, undefined);
    }

    metrics.initialize(history, monitoring.scenarios, scenario => scenarioSettings(config, scenario).intervalMs);
    workers.push(every(clock, ALERT_BACKLOG_METRIC_MS, background.signal, () => {
      metrics.setAlertBacklog((alerter.health().backlogAgeMs ?? 0) / MS_PER_SECOND);
    }, (error) => {
      logger.error('could not update the alert backlog metric', { error });
    }));

    const built = await buildRunners({ config,
      history,
      clock,
      logger,
      masking,
      api,
      collector,
      overrides,
      closers });

    const scheduler = createScheduler({ runners: built.runners,
      history,
      clock,
      logger,
      config,
      redact: masking.redact,
      beforeFirstRun: built.beforeFirstRun,
      onRunFinished: [(row, result) => {
        alerter.onRunFinished(row, result);
      }, (row, result) => {
        metrics.onRunFinished(row, result);
      }],
      exit });
    const sweeper = createSweeper({ api,
      history,
      clock,
      logger,
      config,
      activeRunIds: () => scheduler.activeRunIds(),
      ...overrides.sweepFirstDelayMs === undefined ? {} : { firstPassDelayMs: overrides.sweepFirstDelayMs } });
    const liveness: Check[] = [
      { name: 'scheduler',
        run: async () => Promise.resolve(scheduler.health().scheduler) },
      { name: 'storage',
        run: async () => Promise.resolve(scheduler.health().storage && !alerter.health().storageFailing) },
      ...monitoring.scenarios.map(scenario => ({ name: `scenario ${scenario} stuck busy`,
        run: async () => Promise.resolve(!scheduler.health().stuck.includes(scenario)) })),
    ];
    const readiness: Check[] = [
      { name: 'history',
        run: async () => {
          history.getKv('serve_lease');

          return Promise.resolve(true);
        } },
      ...built.readiness,
      { name: 'alerts',
        run: async () => {
          const age = alerter.health().backlogAgeMs;

          return Promise.resolve(age === null || age <= ALERT_BACKLOG_LIMIT_MS);
        } },
    ];
    const app = await startApp(config, { logger,
      clock,
      liveness,
      readiness,
      routes: createRoutes({ history,
        config,
        clock,
        scheduler,
        alerter,
        sweepFailures: () => sweeper.failures(),
        metrics }) });

    closers.push(async () => app.stop());
    closers.push(async () => scheduler.stop());
    closers.push(async () => sweeper.stop());

    const heartbeat = createServeHeartbeat({ config,
      clock,
      logger,
      redact: masking.redact,
      scheduler,
      alerter,
      metrics });

    if (heartbeat !== undefined) {
      closers.push(() => {
        heartbeat.stop();
      });
    }

    scheduler.start();
    sweeper.start();
    heartbeat?.start();
    logger.info('serve started', { scenarios: monitoring.scenarios,
      intervalMs: monitoring.intervalMs,
      databasePath: monitoring.databasePath });

    let stopPromise: Promise<void> | undefined;

    return {
      port: app.port,
      ...built.receiverPort === undefined ? {} : { receiverPort: built.receiverPort },
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
