import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupError } from '../app.js';
import type { Config } from '../config/load.js';
import { createProvisioner } from '../notifications/provisioning.js';
import { openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import type { History, RunWithResult } from '../storage/history.js';
import { MATCH_CHANGED_KEY } from '../storage/keys.js';
import { LEASE_KEY, writeLease } from '../storage/lease.js';
import type { RunRow } from '../storage/types.js';
import { httpAddress } from '../test-support/address.js';
import { seedLease, tempDatabase } from '../test-support/database.js';
import type { TempDatabase } from '../test-support/database.js';
import { TEST_RECEIVER_SECRET } from '../test-support/env.js';
import { startFakeCollector } from '../test-support/fake-hawk/collector.js';
import type { FakeCollector } from '../test-support/fake-hawk/collector.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeHawk } from '../test-support/fake-hawk/index.js';
import { decodeTokenKey } from '../test-support/fake-hawk/token.js';
import { startFakeNotify } from '../test-support/fake-notify.js';
import type { FakeNotify, FakeNotifyAnswer } from '../test-support/fake-notify.js';
import { memoryLogger } from '../test-support/logger.js';
import type { MemoryLogger } from '../test-support/logger.js';
import { createTestDeps } from '../test-support/scenario.js';
import { startServe } from './serve.js';
import type { ProcessIdentity, ServeHandle } from './serve.js';

const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';
const WAIT = { timeout: 15_000,
  interval: 25 };
const FAKE_ID = 'fake';

/** One scenario in `/stats`. */
interface StatsEntry {
  /** Scenario. */
  scenario: string;
  /** Last 24 hours. */
  last24h: {
    /** Runs that ended ok. */
    ok: number;
  };
}

/** The part of `/stats` the tests read. */
interface StatsBody {
  /** Time of the answer. */
  generatedAt: string;
  /** Statistics per scenario. */
  scenarios: StatsEntry[];
  /** Failed writes. */
  storageFailures: number;
  /** Failed sweeps. */
  sweepFailures: number;
  /** Age of the oldest unsent alert. */
  alertBacklogAgeMs: number | null;
  /** Rejections in a row. */
  alertRejected: number;
}

/** A 400 answer. */
interface ErrorBody {
  /** Kind of the error. */
  error: string;
  /** What is wrong. */
  message: string;
}

/** A proxy that starts forwarding after some requests. */
interface Proxy {
  /** Port it listens on. */
  port: number;
  /**
   * Counts the requests seen.
   * @returns Number of requests.
   */
  hits(): number;
}

/** Everything a test needs from a running serve. */
interface Harness {
  /** Handle of the serve. */
  handle: ServeHandle;
  /** Fake Hawk. */
  hawk: FakeHawk;
  /** Fake bot. */
  bot: FakeNotify;
  /** Log of the serve. */
  logger: MemoryLogger;
  /** Configuration the serve got. */
  config: Config;
  /** The `exit` spy. */
  exit: ReturnType<typeof vi.fn<(code: number) => void>>;
  /** Database file. */
  database: TempDatabase;
}

/** What a test may change. */
interface LaunchOptions {
  /** Scenarios to run; send-and-receive only by default. */
  scenarios?: Array<typeof NOTIFY | typeof SEND>;
  /** Interval between runs of a scenario. */
  intervalMs?: number;
  /** Stagger between the first runs. */
  staggerMs?: number;
  /** Variables for the configuration. */
  env?: Record<string, string>;
  /** First answer of the bot. */
  answer?: FakeNotifyAnswer;
  /** Port of the receiver, random by default. */
  receiverPort?: number;
  /** Writes to the database before the serve starts. */
  seed?: (history: History) => void;
  /** Identity of the process. */
  identity?: ProcessIdentity;
  /** Address lookup of the scenario; gets the configured port of the receiver. */
  resolveAddress?: (port: number) => Promise<ReturnType<typeof httpAddress>>;
  /** Wait between self-checks of a new address. */
  addressPollMs?: number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/**
 * Calls the address lookup of a test, which may be absent.
 * @param lookup Lookup of the test.
 * @param port Configured port of the receiver.
 * @returns The address.
 */
async function resolveFor(lookup: LaunchOptions['resolveAddress'], port: number): Promise<ReturnType<typeof httpAddress>> {
  if (lookup === undefined) {
    throw new Error('The test gave no address lookup');
  }

  return lookup(port);
}

/**
 * Starts a fake Hawk that is closed after the test.
 * @returns Running fake.
 */
async function hawkFor(): Promise<FakeHawk> {
  const hawk = await startFakeHawk();

  // A short interval projects far more events than a real plan; a high limit keeps that warning out of the way.
  hawk.api.knobs.workspace = { isBlocked: false,
    eventsLimit: 1_000_000_000_000,
    billingPeriodEventsCount: 0 };
  cleanups.push(async () => hawk.close());

  return hawk;
}

/**
 * Finds a port nobody listens on.
 * @returns A port that was free a moment ago.
 */
async function freePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  return port;
}

/**
 * Starts the serve on a fake Hawk and a fake bot, with real clocks and short intervals.
 * @param options Differences from the defaults.
 * @param hawk Fake Hawk to use; a new one by default.
 * @returns The serve with its parts.
 */
async function launch(options: LaunchOptions = {}, hawk?: FakeHawk): Promise<Harness> {
  const fake = hawk ?? await hawkFor();
  const bot = await startFakeNotify(options.answer);
  const database = await tempDatabase();
  const logger = memoryLogger();
  const exit = vi.fn<(code: number) => void>();
  const { deps } = createTestDeps(fake, { env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9',
    ...options.env } });
  const config: Config = { ...deps.config,
    shutdownTimeoutMs: 1000,
    internal: { host: '127.0.0.1',
      port: 0 },
    notifications: { ...deps.config.notifications,
      receiverPort: options.receiverPort ?? 0 },
    monitoring: { ...deps.config.monitoring,
      scenarios: options.scenarios ?? [SEND],
      intervalMs: options.intervalMs ?? 700,
      staggerMs: options.staggerMs ?? 0,
      databasePath: database.path,
      alertNotifyUrl: bot.url,
      alertRetryMs: 1000 } };

  if (options.seed !== undefined) {
    const history = createHistory(openDatabase(database.path));

    options.seed(history);
    history.close();
  }

  const handle = await startServe({ config,
    logger,
    exit,
    ...options.identity === undefined ? {} : { identity: options.identity },
    overrides: { api: deps.api,
      collector: deps.collector,
      pollScheduleMs: [20, 40],
      retryDelaysMs: [5, 10],
      ...options.addressPollMs === undefined ? {} : { addressPollMs: options.addressPollMs },
      ...options.resolveAddress === undefined ? {} : { resolveAddress: async () => resolveFor(options.resolveAddress, options.receiverPort ?? 0) } } });

  cleanups.push(async () => {
    await handle.stop();
    await bot.close();
    await database.remove();
  });

  return { handle,
    hawk: fake,
    bot,
    logger,
    config,
    exit,
    database };
}

/**
 * Reads the database of a serve through a second, read-only connection.
 * @param harness Running serve.
 * @param read What to read.
 * @returns What `read` returned.
 */
function inspect<T>(harness: Harness, read: (history: History) => T): T {
  const history = createHistory(openDatabase(harness.database.path, { readOnly: true }));

  try {
    return read(history);
  } finally {
    history.close();
  }
}

/**
 * Takes the finished rows of a scenario, oldest first.
 * @param harness Running serve.
 * @param scenario Scenario whose rows are read.
 * @returns Rows that are not running.
 */
function finishedRows(harness: Harness, scenario: typeof NOTIFY | typeof SEND = SEND): RunRow[] {
  return inspect(harness, history => history.list({ scenario,
    limit: 100 })).filter(row => row.status !== 'running')
    .toReversed();
}

/**
 * Fetches a path of the internal server.
 * @param harness Running serve.
 * @param path Path with the query.
 * @returns Response.
 */
async function get(harness: Harness, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(harness.handle.port)}${path}`);
}

/**
 * Takes the first words in bold of the messages the bot received.
 * @param bot Fake bot.
 * @returns Titles in arrival order.
 */
function titles(bot: FakeNotify): string[] {
  return bot.requests.map(request => /<b>([^<]+)<\/b>/u.exec(request.form.message ?? '')?.[1] ?? '');
}

describe('serve: scheduled runs and the history routes', () => {
  it('runs the scenario twice, stores both runs and serves them through the routes', async () => {
    const harness = await launch();

    await vi.waitFor(() => {
      expect(finishedRows(harness).filter(row => row.status === 'ok')).toHaveLength(2);
    }, WAIT);

    const [first, second] = finishedRows(harness);
    const list = await (await get(harness, '/runs')).json() as RunRow[];

    expect([first?.sequence, second?.sequence]).toEqual([1, 2]);
    expect(list.map(row => row.runId)).toContain(first?.runId);
    expect((list[0]?.startedAt ?? '') >= (list.at(-1)?.startedAt ?? '')).toBe(true);

    const one = await get(harness, `/runs/${first?.runId ?? ''}`);
    const body = await one.json() as RunWithResult;

    expect(one.status).toBe(200);
    expect(one.headers.get('cache-control')).toBe('no-store');
    expect(body.result?.runId).toBe(first?.runId);
    expect(body.stages.length).toBeGreaterThan(0);

    const stats = await (await get(harness, '/stats')).json() as StatsBody;

    expect(stats.scenarios[0]).toMatchObject({ scenario: SEND });
    expect(stats.scenarios[0]?.last24h.ok).toBeGreaterThanOrEqual(2);
    expect(stats).toMatchObject({ storageFailures: 0,
      sweepFailures: 0,
      alertRejected: 0,
      alertBacklogAgeMs: null });
    expect(typeof stats.generatedAt).toBe('string');
    expect(harness.bot.requests).toHaveLength(0);
  });

  it('warns once with DEGRADED when the projected spend exceeds the quota of the plan', async () => {
    const hawk = await hawkFor();

    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 1000,
      billingPeriodEventsCount: 0 };

    const harness = await launch({}, hawk);

    await vi.waitFor(() => {
      expect(finishedRows(harness).filter(row => row.status === 'ok')).toHaveLength(2);
    }, WAIT);
    expect(finishedRows(harness)[0]?.degraded).toEqual(['quota_projection']);
    await vi.waitFor(() => {
      expect(titles(harness.bot)).toEqual(['DEGRADED']);
    }, WAIT);
    expect(harness.bot.requests[0]?.form.message).toContain('quota_projection');
  });

  it('filters and limits /runs and rejects bad parameters with a text', async () => {
    const harness = await launch();

    await vi.waitFor(() => {
      expect(finishedRows(harness)).not.toHaveLength(0);
    }, WAIT);

    expect(((await (await get(harness, `/runs?scenario=${SEND}&limit=1`)).json()) as RunRow[])).toHaveLength(1);
    expect(((await (await get(harness, `/runs?scenario=${NOTIFY}`)).json()) as RunRow[])).toHaveLength(0);

    for (const query of ['limit=0', 'limit=501', 'limit=abc', 'scenario=nope']) {
      const response = await get(harness, `/runs?${query}`);
      const body = await response.json() as ErrorBody;

      expect(response.status).toBe(400);
      expect(body.error).toBe('bad_request');
      expect(body.message).not.toBe('');
    }
  });

  it('answers 404 for an unknown run', async () => {
    const harness = await launch();
    const response = await get(harness, '/runs/rzzzzzzzzzzzzzzzz');

    expect(response.status).toBe(404);
  });

  it('writes no secret of the bot into the log', async () => {
    const hawk = await hawkFor();

    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const harness = await launch({ answer: { status: 404,
      body: 'no chat' } }, hawk);

    await vi.waitFor(() => {
      expect(harness.bot.requests.length).toBeGreaterThan(0);
    }, WAIT);
    expect(JSON.stringify(harness.logger.lines)).not.toContain(harness.bot.token);
    expect(JSON.stringify(harness.logger.lines)).not.toContain(harness.bot.url);
  });
});

describe('serve: independence from Hawk', () => {
  it('a closed collector fails the run, FAILED goes out, and a reopened one recovers it with RECOVERED', async () => {
    const hawk = await hawkFor();
    const harness = await launch({ intervalMs: 500 }, hawk);
    const port = Number(new URL(hawk.collector.url).port);

    await vi.waitFor(() => {
      expect(finishedRows(harness).some(row => row.status === 'ok')).toBe(true);
    }, WAIT);
    await hawk.collector.close();
    await vi.waitFor(() => {
      expect(finishedRows(harness).some(row => row.status === 'failed')).toBe(true);
    }, WAIT);

    const failed = finishedRows(harness).find(row => row.status === 'failed');

    expect(failed).toMatchObject({ failedStage: 'collector_availability' });
    expect(['collector_unavailable', 'dns_error']).toContain(failed?.errorClass);
    await vi.waitFor(() => {
      expect(titles(harness.bot)).toContain('FAILED');
    }, WAIT);

    const reopened: FakeCollector = await startFakeCollector({ store: hawk.store,
      projectId: hawk.projectId,
      validTokenKey: decodeTokenKey(hawk.token) ?? '',
      port });

    cleanups.push(async () => reopened.close());
    await vi.waitFor(() => {
      expect(titles(harness.bot)).toContain('RECOVERED');
    }, WAIT);
    expect(titles(harness.bot)).toEqual(['FAILED', 'RECOVERED']);
    expect(finishedRows(harness).at(-1)?.status).toBe('ok');
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it('an API that answers 503 fails the run with api_unavailable and the process stays up', async () => {
    const hawk = await hawkFor();

    hawk.api.knobs.down = true;

    const harness = await launch({}, hawk);

    await vi.waitFor(() => {
      expect(finishedRows(harness).some(row => row.status === 'failed')).toBe(true);
    }, WAIT);
    expect(finishedRows(harness)[0]).toMatchObject({ failedStage: 'api_availability',
      errorClass: 'api_unavailable' });
    expect((await get(harness, '/healthz')).status).toBe(200);
  });
});

describe('serve: start and stop', () => {
  it('turns runs left in running by an earlier process into aborted monitor_restarted', async () => {
    const harness = await launch({ intervalMs: 600_000,
      seed: (history) => {
        history.startRun({ runId: 'rsssssssssssssss',
          scenario: SEND,
          sequence: 7,
          trigger: 'schedule',
          startedAt: new Date(Date.now() - 3_600_000 * 2).toISOString() });
      } });

    expect(inspect(harness, history => history.get('rsssssssssssssss'))).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_restarted' });
    await vi.waitFor(() => {
      expect(finishedRows(harness).some(row => row.status === 'ok')).toBe(true);
    }, WAIT);
    expect(finishedRows(harness).find(row => row.status === 'ok')?.sequence).toBe(8);
  });

  it('keeps its lease while it runs and gives it up on stop; a second serve with another process is refused', async () => {
    const harness = await launch({ identity: { hostname: 'box-a',
      pid: 1 } });

    expect(inspect(harness, history => history.getKv(LEASE_KEY))).toContain('"pid":1');

    const second = startServe({ config: harness.config,
      logger: memoryLogger(),
      identity: { hostname: 'box-a',
        pid: 2 } });

    await expect(second).rejects.toBeInstanceOf(StartupError);
    await expect(second).rejects.toThrow(`Another serve (pid 1) is running for DATABASE_PATH ${harness.config.monitoring.databasePath}`);

    await harness.handle.stop();
    expect(inspect(harness, history => history.getKv(LEASE_KEY))).toBeUndefined();
  });

  it('takes over the lease of a predecessor with the same host and process id, as after a restart of the container', async () => {
    const harness = await launch({ identity: { hostname: 'box-a',
      pid: 1 },
    seed: (history) => {
      writeLease(history, { pid: 1,
        hostname: 'box-a',
        at: new Date().toISOString() });
    } });

    expect(harness.handle.port).toBeGreaterThan(0);
  });

  it('refuses to start when the lease of another host is alive', async () => {
    const hawk = await hawkFor();
    const database = await tempDatabase();
    const { deps } = createTestDeps(hawk);

    cleanups.push(async () => database.remove());
    seedLease(database.path, { pid: 9,
      hostname: 'other-box',
      at: new Date().toISOString() });

    await expect(startServe({ config: { ...deps.config,
      monitoring: { ...deps.config.monitoring,
        databasePath: database.path } },
    logger: memoryLogger(),
    identity: { hostname: 'box-a',
      pid: 1 } })).rejects.toThrow('Another serve (pid 9)');
  });

  it('names the path when the database cannot be opened', async () => {
    const hawk = await hawkFor();
    const database = await tempDatabase();
    const { deps } = createTestDeps(hawk);

    cleanups.push(async () => database.remove());
    // A file stands where the directory of the database should be.
    await writeFile(join(dirname(database.path), 'blocker'), 'x');

    const path = join(dirname(database.path), 'blocker', 'monitor.db');

    await expect(startServe({ config: { ...deps.config,
      monitoring: { ...deps.config.monitoring,
        databasePath: path } },
    logger: memoryLogger() })).rejects.toThrow(`Cannot open DATABASE_PATH ${path}: `);
  });

  it('stop aborts a run that is going, records monitor_stopped and can be called twice', async () => {
    const hawk = await hawkFor();

    // The event never shows up, so the run waits in event_visible.
    hawk.collector.knobs.dropEvents = true;

    const harness = await launch({}, hawk);

    await vi.waitFor(() => {
      expect(inspect(harness, history => history.list({ limit: 5 })).some(row => row.status === 'running')).toBe(true);
    }, WAIT);

    const first = harness.handle.stop();

    expect(harness.handle.stop()).toBe(first);
    await first;

    const rows = inspect(harness, history => history.list({ limit: 5 }));

    expect(rows[0]).toMatchObject({ status: 'aborted',
      errorClass: 'monitor_stopped' });
    expect(inspect(harness, history => history.getKv(LEASE_KEY))).toBeUndefined();
  });

  it('/healthz is 503 once the scheduler is stopped, /readyz tells what is ready', async () => {
    const harness = await launch();

    expect((await get(harness, '/healthz')).status).toBe(200);
    expect((await get(harness, '/readyz')).status).toBe(200);
    await harness.handle.scheduler.stop();

    const response = await get(harness, '/healthz');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail',
      failed: ['scheduler'] });
  });
});

describe('serve: notifications', () => {
  /**
   * Posts a body to a channel of the receiver the way Hawk would.
   * @param harness Running serve.
   * @param body Raw body.
   * @returns Response.
   */
  async function postWebhook(harness: Harness, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(harness.handle.receiverPort)}/hooks/webhook/${TEST_RECEIVER_SECRET}`, { method: 'POST',
      body });
  }

  /**
   * Stores a finished failed run of the notification scenario.
   * @param history History to write to.
   */
  function seedFinished(history: History): void {
    history.startRun({ runId: 'rkkkkkkkkkkkkkkk',
      scenario: NOTIFY,
      sequence: 1,
      trigger: 'schedule',
      startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    history.finishRun('rkkkkkkkkkkkkkkk', { status: 'failed',
      finishedAt: new Date(Date.now() - 3_000_000).toISOString(),
      durationMs: 1000,
      degraded: [] });
  }

  it('marks a late notification of a finished run, and a repeat of it as a duplicate', async () => {
    const harness = await launch({ scenarios: [SEND, NOTIFY],
      staggerMs: 3_600_000,
      seed: seedFinished });
    const title = `[e2e:${FAKE_ID}] rkkkkkkkkkkkkkkk ${NOTIFY}`;

    expect(harness.handle.receiverPort).toBeGreaterThan(0);
    expect((await postWebhook(harness, JSON.stringify({ title }))).status).toBe(200);
    await vi.waitFor(() => {
      expect(inspect(harness, history => history.get('rkkkkkkkkkkkkkkk'))?.lateNotificationAt).toBeDefined();
    }, WAIT);
    expect(inspect(harness, history => history.get('rkkkkkkkkkkkkkkk'))?.lateNotificationChannel).toBe('webhook');

    await postWebhook(harness, JSON.stringify({ title }));
    await vi.waitFor(() => {
      expect(inspect(harness, history => history.get('rkkkkkkkkkkkkkkk'))?.lateDuplicateNotificationAt).toBeDefined();
    }, WAIT);
  });

  it('ignores a notification of another instance and one with an unknown run id', async () => {
    const harness = await launch({ scenarios: [SEND, NOTIFY],
      staggerMs: 3_600_000,
      seed: seedFinished });

    await postWebhook(harness, JSON.stringify({ title: `[e2e:other] rkkkkkkkkkkkkkkk ${NOTIFY}` }));
    await postWebhook(harness, JSON.stringify({ title: `[e2e:${FAKE_ID}] rnnnnnnnnnnnnnnn ${NOTIFY}` }));
    await vi.waitFor(() => {
      expect(harness.logger.lines.filter(line => line.msg === 'late notification')).toHaveLength(2);
    }, WAIT);
    expect(inspect(harness, history => history.get('rkkkkkkkkkkkkkkk'))?.lateNotificationAt).toBeUndefined();
  });

  it('has no receiver when the notification scenario is off', async () => {
    const harness = await launch();

    expect(harness.handle.receiverPort).toBeUndefined();
  });

  /**
   * Provisions the rule the way an earlier process did, so a run sees no change of its own.
   * @param hawk Fake Hawk.
   * @param config Configuration of the serve.
   * @param port Port of the receiver.
   * @returns Resolves when the rule is in place.
   */
  async function preProvision(hawk: FakeHawk, config: Config, port: number): Promise<void> {
    const { deps } = createTestDeps(hawk);
    const provisioner = createProvisioner({ api: deps.api,
      clock: deps.clock,
      projectId: hawk.projectId,
      instanceId: config.instanceId,
      secret: TEST_RECEIVER_SECRET,
      loop: true,
      warmupMs: 65_000 });

    await provisioner.provision(httpAddress(port), AbortSignal.timeout(5000));
  }

  it('takes the warmup of the last rule change from the database, so the first run is skipped', async () => {
    const hawk = await hawkFor();
    const port = await freePort();
    const { deps } = createTestDeps(hawk, { env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
      TUNNEL_METRICS_URL: 'http://127.0.0.1:9' } });

    await preProvision(hawk, deps.config, port);

    const harness = await launch({ scenarios: [NOTIFY],
      receiverPort: port,
      env: { RULE_CACHE_WARMUP_MS: '65000' },
      resolveAddress: async receiverPort => Promise.resolve(httpAddress(receiverPort)),
      seed: (history) => {
        history.setKv(MATCH_CHANGED_KEY, new Date(Date.now() - 10_000).toISOString());
      } }, hawk);

    await vi.waitFor(() => {
      expect(finishedRows(harness, NOTIFY)).not.toHaveLength(0);
    }, WAIT);

    const [row] = finishedRows(harness, NOTIFY);

    expect(row).toMatchObject({ status: 'skipped',
      skipReason: 'rule_cache_warmup' });

    const stage = inspect(harness, history => history.get(row?.runId ?? ''))?.result?.stages.find(item => item.name === 'notification_formed');
    const remaining = stage?.details?.warmupRemainingMs;

    expect(remaining).toBeGreaterThan(40_000);
    expect(remaining).toBeLessThanOrEqual(55_000);
  });

  it('never waits longer than the warmup when the stored time is in the future', async () => {
    const hawk = await hawkFor();
    const port = await freePort();
    const { deps } = createTestDeps(hawk, { env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
      TUNNEL_METRICS_URL: 'http://127.0.0.1:9' } });

    await preProvision(hawk, deps.config, port);

    const harness = await launch({ scenarios: [NOTIFY],
      receiverPort: port,
      env: { RULE_CACHE_WARMUP_MS: '65000' },
      resolveAddress: async receiverPort => Promise.resolve(httpAddress(receiverPort)),
      seed: (history) => {
        history.setKv(MATCH_CHANGED_KEY, new Date(Date.now() + 600_000).toISOString());
      } }, hawk);

    await vi.waitFor(() => {
      expect(finishedRows(harness, NOTIFY)).not.toHaveLength(0);
    }, WAIT);

    const [row] = finishedRows(harness, NOTIFY);
    const stage = inspect(harness, history => history.get(row?.runId ?? ''))?.result?.stages.find(item => item.name === 'notification_formed');

    expect(row?.status).toBe('skipped');
    expect(stage?.details?.warmupRemainingMs).toBeLessThanOrEqual(65_000);
  });

  describe('after the tunnel address changed', () => {
    const servers: Server[] = [];

    afterEach(async () => {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    });

    /**
     * Starts a proxy that does not answer the first requests and then forwards to the receiver.
     * @param receiverPort Port the receiver listens on.
     * @param silentHits How many first requests get a wrong answer.
     * @returns The port of the proxy and the number of requests it saw.
     */
    async function lateProxy(receiverPort: number, silentHits: number): Promise<Proxy> {
      let hits = 0;
      const server = createServer((req, res) => {
        hits += 1;

        const chunks: Buffer[] = [];

        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          if (hits <= silentHits) {
            res.statusCode = 200;
            res.end('not the receiver');

            return;
          }

          const headers = new Headers();

          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string' && !['connection', 'content-length', 'host'].includes(name)) {
              headers.set(name, value);
            }
          }

          fetch(`http://127.0.0.1:${String(receiverPort)}${req.url ?? '/'}`, { method: req.method ?? 'GET',
            headers,
            ...req.method === 'POST' ? { body: Buffer.concat(chunks) } : {} }).then(async (answer) => {
            res.statusCode = answer.status;
            res.end(await answer.text());
          })
            .catch(() => {
              res.destroy();
            });
        });
      });

      servers.push(server);
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });

      return { port: (server.address() as AddressInfo).port,
        hits: () => hits };
    }

    it('waits for the new address to answer before it changes the rule, and the next run is ok', async () => {
      const hawk = await hawkFor();
      const receiverPort = await freePort();
      const { deps } = createTestDeps(hawk, { env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
        TUNNEL_METRICS_URL: 'http://127.0.0.1:9',
        RULE_CACHE_WARMUP_MS: '50' } });

      await preProvision(hawk, deps.config, receiverPort);

      const proxy = await lateProxy(receiverPort, 2);
      let current = receiverPort;
      const harness = await launch({ scenarios: [NOTIFY],
        receiverPort,
        intervalMs: 1500,
        addressPollMs: 20,
        env: { RULE_CACHE_WARMUP_MS: '50' },
        resolveAddress: async () => Promise.resolve(httpAddress(current)) }, hawk);

      await vi.waitFor(() => {
        expect(finishedRows(harness, NOTIFY).some(row => row.status === 'ok')).toBe(true);
      }, WAIT);

      // The tunnel restarted under a new address; the proxy stands for it.
      current = proxy.port;
      await vi.waitFor(() => {
        expect(finishedRows(harness, NOTIFY).filter(row => row.status === 'ok')).toHaveLength(2);
      }, WAIT);
      expect(proxy.hits()).toBeGreaterThanOrEqual(3);
    });
  });
});
