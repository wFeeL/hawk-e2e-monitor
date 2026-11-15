import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/engine/result.js';
import type { CheckCommand } from '../../src/cli.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { httpAddress } from '../support/address.js';
import { TEST_RECEIVER_SECRET } from '../support/env.js';
import { createNotificationTestDeps, createTestDeps } from '../support/scenario.js';
import type { NotificationTestDeps, NotificationTestOptions } from '../support/scenario.js';
import type { Config } from '../../src/config/load.js';
import type { NotificationDeps } from '../../src/scenarios/check-notification/run.js';
import { runCheckCommand } from '../../src/commands/check.js';
import type { CheckIo } from '../../src/commands/check.js';
import { seedLease, tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { LEASE_TTL_MS } from '../../src/storage/lease.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { MATCH_CHANGED_KEY } from '../../src/storage/keys.js';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { systemClock } from '../../src/time/clock.js';

const COMMAND: CheckCommand = { kind: 'check',
  scenario: 'send-and-receive-event',
  sequence: 1,
  repeat: false };

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/** One line of the log. */
interface LogLine {
  /** Log message. */
  msg: string;
}

/** What a run wrote and returned. */
interface Captured {
  /** Exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Runs the command on the fake Hawk and captures its output.
 * @param command Parsed command.
 * @returns Exit code and both streams.
 */
async function runCommand(command: CheckCommand = COMMAND): Promise<Captured> {
  const { deps } = createTestDeps(hawk);
  const captured: Captured = { code: -1,
    stdout: '',
    stderr: '' };
  const io: CheckIo = {
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  };

  captured.code = await runCheckCommand(command, deps.config, io, { pollScheduleMs: deps.pollScheduleMs });

  return captured;
}

describe('runCheckCommand', () => {
  it('stdout parses as one JSON line with the run result', async () => {
    const { stdout } = await runCommand();
    const result = JSON.parse(stdout) as RunResult;

    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(result).toMatchObject({ scenario: 'send-and-receive-event',
      status: 'ok',
      sequence: 1,
      transport: 'http' });
  });

  it('exit 0 on ok', async () => {
    const { code, stderr } = await runCommand();

    expect(code).toBe(0);
    expect(stderr).toContain('ok');
  });

  it('exit 1 on failure, with a summary line on stderr', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const { code, stdout, stderr } = await runCommand();
    const result = JSON.parse(stdout) as RunResult;

    expect(code).toBe(1);
    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_availability',
      errorClass: 'collector_dependency_error' });
    expect(stderr).toContain(`failed collector_availability collector_dependency_error: ${result.message ?? ''}`);
  });

  it('logs go to stderr only', async () => {
    const { stdout, stderr } = await runCommand();
    const logLines = stderr.split('\n').filter(line => line.startsWith('{'));

    expect(logLines.map(line => (JSON.parse(line) as LogLine).msg)).toContain('run finished');
    expect(stdout).not.toContain('run finished');
    expect(JSON.parse(stdout)).toBeTypeOf('object');
  });

  it('passes the transport and repeat flags to the run', async () => {
    const { code, stdout } = await runCommand({ ...COMMAND,
      sequence: 3,
      transport: 'ws',
      repeat: true });
    const result = JSON.parse(stdout) as RunResult;

    expect(code).toBe(0);
    expect(result).toMatchObject({ sequence: 3,
      transport: 'ws' });
    expect(result.stages.find(stage => stage.name === 'event_repeated')?.status).toBe('ok');
  });

  it('without --repeat the repeat follows the config', async () => {
    const { stdout } = await runCommand({ ...COMMAND,
      sequence: 1 });
    const result = JSON.parse(stdout) as RunResult;

    expect(result.stages.find(stage => stage.name === 'event_repeated')?.status).toBe('skipped');
  });

  it('writes no password or token to either stream', async () => {
    const { stdout, stderr } = await runCommand();

    for (const secret of [hawk.password, hawk.token]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });
});

/** Configuration and dependencies of a command run. */
interface Setup {
  /** Configuration. */
  config: Config;
  /** Dependencies that replace the built ones. */
  deps: Partial<NotificationDeps>;
}

/** Changes the setup of a command run. */
type Adjust = (config: Config, deps: Partial<NotificationDeps>) => Setup;

const NOTIFICATION_COMMAND: CheckCommand = { kind: 'check',
  scenario: 'check-notification',
  sequence: 1,
  repeat: false };

describe('runCheckCommand with check-notification', () => {
  let parts: NotificationTestDeps | undefined;
  let database: TempDatabase;
  const servers: Server[] = [];

  // A check that changes the rule writes the change time, so no test may use the default path.
  beforeEach(async () => {
    database = await tempDatabase();
  });

  afterEach(async () => {
    await database.remove();
    await parts?.close();
    parts = undefined;
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      server.close();
    }
  });

  /**
   * Runs `check check-notification` with the pieces of a test setup and captures its output.
   * @param options Setup overrides.
   * @param adjust Changes the configuration and the dependencies before the run.
   * @returns Exit code and both streams.
   */
  async function runNotification(options: NotificationTestOptions = {}, adjust: Adjust = (config, deps) => ({ config,
    deps })): Promise<Captured> {
    const setup = await createNotificationTestDeps(hawk, { ...options,
      env: { DATABASE_PATH: database.path,
        ...options.env } });

    parts = setup;

    const captured: Captured = { code: -1,
      stdout: '',
      stderr: '' };
    const io: CheckIo = {
      stdout: (text) => {
        captured.stdout += text;
      },
      stderr: (text) => {
        captured.stderr += text;
      },
    };
    const { config, deps } = adjust(setup.deps.config, { receiver: setup.receiver,
      resolveAddress: setup.resolveAddress,
      pollScheduleMs: setup.deps.pollScheduleMs });

    captured.code = await runCheckCommand(NOTIFICATION_COMMAND, config, io, deps);

    return captured;
  }

  /**
   * Finds a port that is free right now.
   * @returns Its number.
   */
  async function freePort(): Promise<number> {
    const probe = createServer();

    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', resolve);
    });

    const { port } = probe.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });

    return port;
  }

  it('prints the result of the new scenario and exits 0', async () => {
    const { code, stdout, stderr } = await runNotification();
    const result = JSON.parse(stdout) as RunResult;

    expect(code).toBe(0);
    expect(result).toMatchObject({ scenario: 'check-notification',
      status: 'ok' });
    expect(result.notification?.webhook).toBeDefined();
    expect(stderr).toContain('ok\n');
  });

  it('puts the number of warnings into the summary', async () => {
    hawk.notifier.knobs.loopOff = true;

    const { code, stderr } = await runNotification();

    expect(code).toBe(0);
    expect(stderr).toContain('ok (1 warning)\n');
  });

  it('exits 1 with the failed stage and class on a failure', async () => {
    hawk.notifier.knobs.off = true;

    const { code, stdout, stderr } = await runNotification({ env: { NOTIFICATION_TIMEOUT_MS: '300' } });

    expect(code).toBe(1);
    expect((JSON.parse(stdout) as RunResult).errorClass).toBe('notification_timeout');
    expect(stderr).toContain('failed notification_formed notification_timeout:');
  });

  it('logs and stdout hide the secret and the hostname, also in the text Hawk gives about an unresolvable host', async () => {
    hawk.api.knobs.unresolvableHosts = ['127.0.0.1'];

    const { code, stdout, stderr } = await runNotification({ preProvision: false,
      env: { LOG_LEVEL: 'debug' } }, (config, deps) => ({ config,
      deps: { ...deps,
        resolveAddress: () => Promise.resolve(httpAddress(parts?.receiver.port ?? 0, 'tunnel')) } }));
    const output = `${stdout}${stderr}`;

    expect(code).toBe(1);
    expect(stderr).toContain('failed notification_setup tunnel_unavailable:');
    expect(stderr).toContain('run finished');
    expect(output).toContain('***');
    expect(output).not.toContain(TEST_RECEIVER_SECRET);
    expect(output).not.toContain('127.0.0.1');
  });

  it('a missing secret is a configuration error and nothing runs', async () => {
    const { code, stdout, stderr } = await runNotification({}, (config, deps) => ({ config: { ...config,
      notifications: { ...config.notifications,
        receiverSecret: undefined } },
    deps }));

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('RECEIVER_SECRET');
    expect(hawk.collector.posts).toBe(0);
  });

  it('keeps a receiver that the caller gave', async () => {
    await runNotification();

    const response = await fetch(`${parts?.address.baseUrl ?? ''}/hooks/probe/${TEST_RECEIVER_SECRET}`);

    expect(await response.text()).toBe(parts?.receiver.nonce);
  });

  it('starts its own receiver on the configured port and closes it at the end', async () => {
    const port = await freePort();
    const own = httpAddress(port);
    const { code, stderr } = await runNotification({}, (config, deps) => ({ config: { ...config,
      notifications: { ...config.notifications,
        receiverHost: '127.0.0.1',
        receiverPort: port } },
    deps: { ...deps,
      receiver: undefined,
      resolveAddress: () => Promise.resolve(own) } }));

    expect(code, stderr).toBe(0);
    await expect(fetch(`${own.baseUrl}/hooks/probe/${TEST_RECEIVER_SECRET}`)).rejects.toThrow();
  });

  describe('with a database', () => {
    /**
     * Reads the stored time of the last rule change.
     * @returns The stored text, or undefined.
     */
    function storedChange(): string | undefined {
      const history = createHistory(openDatabase(database.path, { readOnly: true }));

      try {
        return history.getKv(MATCH_CHANGED_KEY);
      } finally {
        history.close();
      }
    }

    it('a check that creates the rule records the change and says the notification was not checked', async () => {
      const { code, stderr } = await runNotification({ preProvision: false,
        env: { RULE_CACHE_WARMUP_MS: '300' } });

      expect(code, stderr).toBe(0);
      expect(Number.isNaN(Date.parse(storedChange() ?? ''))).toBe(false);
      expect(stderr).toContain('notification not checked: rule cache warmup');
    });

    /**
     * Stores a rule change time, as an earlier check would have.
     * @param offsetMs Distance from now; negative for the past.
     */
    function storeChange(offsetMs: number): void {
      const history = createHistory(openDatabase(database.path));

      history.setKv(MATCH_CHANGED_KEY, new Date(Date.now() + offsetMs).toISOString());
      history.close();
    }

    it('a check right after a rule change waits out the rest of the warmup and then checks the notification', async () => {
      storeChange(-100);

      const startedAt = Date.now();
      const { code, stdout, stderr } = await runNotification({ env: { RULE_CACHE_WARMUP_MS: '300' } });
      const result = JSON.parse(stdout.trimEnd()) as RunResult;

      expect(code, stderr).toBe(0);
      expect(stderr).toContain('waiting 1 s for Hawk to reload notification rules\n');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
      expect(result.stages.find(stage => stage.name === 'notification_formed')?.status).toBe('ok');
    });

    it('a stored time in the future waits at most the warmup', async () => {
      storeChange(60_000);

      const startedAt = Date.now();
      const { code, stdout, stderr } = await runNotification({ env: { RULE_CACHE_WARMUP_MS: '300' } });
      const result = JSON.parse(stdout.trimEnd()) as RunResult;

      expect(code, stderr).toBe(0);
      expect(stderr).toContain('waiting 1 s for Hawk to reload notification rules\n');
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(result.stages.find(stage => stage.name === 'notification_formed')?.status).toBe('ok');
    });

    it('refuses when a serve started during the wait', async () => {
      storeChange(-100);

      const clock = { ...systemClock,
        sleep: (): Promise<void> => {
          seedLease(database.path, { pid: 4242,
            hostname: 'box',
            at: new Date().toISOString() });

          return Promise.resolve();
        } };
      const { code, stdout, stderr } = await runNotification({ env: { RULE_CACHE_WARMUP_MS: '300' } }, (config, deps) => ({ config,
        deps: { ...deps,
          clock } }));

      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('serve is running for');
      expect(hawk.collector.posts).toBe(0);
    });

    it('an empty database file gives no time and no complaint', async () => {
      await writeFile(database.path, '');

      const { stderr } = await runNotification({ preProvision: false,
        env: { RULE_CACHE_WARMUP_MS: '300' } });

      expect(stderr).not.toContain('could not read the rule change time');
    });

    it('a check that changes nothing does not create the database', async () => {
      const { code, stderr } = await runNotification();

      expect(code, stderr).toBe(0);
      expect(existsSync(database.path)).toBe(false);
    });
  });

  it('a busy receiver port is a failure of the monitor, without a result', async () => {
    const busy = createServer();

    servers.push(busy);
    await new Promise<void>((resolve) => {
      busy.listen(0, '127.0.0.1', resolve);
    });

    const port = (busy.address() as AddressInfo).port;
    const { code, stdout, stderr } = await runNotification({}, (config, deps) => ({ config: { ...config,
      notifications: { ...config.notifications,
        receiverHost: '127.0.0.1',
        receiverPort: port } },
    deps: { ...deps,
      receiver: undefined } }));

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('failed monitor_internal:');
    expect(hawk.collector.posts).toBe(0);
  });
});

describe('runCheckCommand next to a running serve', () => {
  let database: TempDatabase;

  beforeEach(async () => {
    database = await tempDatabase();
  });

  afterEach(async () => {
    await database.remove();
  });

  /**
   * Runs the command with the lease of a `serve` written `ageMs` ago.
   * @param ageMs How long ago the lease was renewed.
   * @returns Exit code and what was written.
   */
  async function runWithLease(ageMs: number): Promise<Captured> {
    const { deps } = createTestDeps(hawk);
    const config = { ...deps.config,
      monitoring: { ...deps.config.monitoring,
        databasePath: database.path } };
    const captured: Captured = { code: -1,
      stdout: '',
      stderr: '' };

    seedLease(database.path, { pid: 4242,
      hostname: 'box',
      at: new Date(Date.now() - ageMs).toISOString() });
    captured.code = await runCheckCommand(COMMAND, config, {
      stdout: (text) => {
        captured.stdout += text;
      },
      stderr: (text) => {
        captured.stderr += text;
      },
    }, { pollScheduleMs: deps.pollScheduleMs });

    return captured;
  }

  it('refuses while the lease is alive and sends nothing', async () => {
    const { code, stdout, stderr } = await runWithLease(1000);

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^serve is running for .+monitor\.db \(lease \d+ s old, pid 4242\); stop it first or start the run through serve\n$/u);
    expect(hawk.collector.posts).toBe(0);
    expect(hawk.api.operations).toHaveLength(0);
  });

  it('works when the lease is older than the TTL', async () => {
    const { code } = await runWithLease(LEASE_TTL_MS + 10_000);

    expect(code).toBe(0);
  });
});

describe('runCheckCommand: endpoints-probe', () => {
  /**
   * Runs the probe command on the fake Hawk.
   * @param env Environment overrides.
   * @returns Exit code and both streams.
   */
  async function runProbe(env: Record<string, string> = {}): Promise<Captured> {
    const { deps } = createTestDeps(hawk, { env });
    const captured: Captured = { code: -1,
      stdout: '',
      stderr: '' };

    captured.code = await runCheckCommand({ kind: 'check',
      scenario: 'endpoints-probe',
      sequence: 1,
      repeat: false }, deps.config, { stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    } });

    return captured;
  }

  it('prints the result of the probe and exits 0, sending no event', async () => {
    const { code, stdout, stderr } = await runProbe();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ scenario: 'endpoints-probe',
      status: 'ok' });
    expect(stderr).toContain('ok\n');
    expect(hawk.collector.posts).toBe(0);
  });

  it('exits 1 with the failed stage and class when a stage fails', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const { code, stderr } = await runProbe();

    expect(code).toBe(1);
    expect(stderr).toContain('failed collector_availability collector_dependency_error:');
  });
});
