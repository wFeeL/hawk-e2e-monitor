import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisionCommand } from '../cli.js';
import type { Config } from '../config/load.js';
import type { PublicAddress } from '../notifications/address.js';
import { createFakeClock } from '../test-support/fake-clock.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeHawk } from '../test-support/fake-hawk/index.js';
import { TEST_RECEIVER_SECRET } from '../test-support/env.js';
import { createTestDeps } from '../test-support/scenario.js';
import type { CheckIo } from './check.js';
import { runProvisionCommand } from './provision.js';

const WAIT: ProvisionCommand = { kind: 'provision',
  wait: true };
const NO_WAIT: ProvisionCommand = { kind: 'provision',
  wait: false };
const HOST = 'abc.trycloudflare.com';

let hawk: FakeHawk;
let config: Config;

/** What a run wrote. */
interface Captured {
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Builds an address on the given host.
 * @param source Where the address came from.
 * @returns Public address.
 */
function address(source: PublicAddress['source'] = 'config'): PublicAddress {
  return { baseUrl: `https://${HOST}`,
    hostname: HOST,
    source };
}

/** Recorded text and the io that fills it. */
interface Capture {
  /** What was written. */
  captured: Captured;
  /** Output streams for the command. */
  io: CheckIo;
}

/**
 * Builds output that records what is written.
 * @returns Captured text and the io that fills it.
 */
function capture(): Capture {
  const captured: Captured = { stdout: '',
    stderr: '' };
  const io: CheckIo = {
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  };

  return { captured,
    io };
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  config = { ...createTestDeps(hawk, { env: { RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9',
    RULE_CACHE_WARMUP_MS: '50' } }).deps.config,
  logLevel: 'debug' };
});

afterEach(async () => {
  await hawk.close();
});

describe('runProvisionCommand', () => {
  it('creates and waits on the fake clock', async () => {
    const clock = createFakeClock();
    const { captured, io } = capture();
    const running = runProvisionCommand(WAIT, config, io, { clock,
      resolveAddress: async () => Promise.resolve(address()) });

    await vi.waitFor(() => {
      expect(clock.pending()).toBe(1);
    });
    expect(captured.stderr).toContain('waiting 1 s for Hawk to reload notification rules');

    await clock.advance(config.notifications.ruleCacheWarmupMs);

    expect(await running).toBe(0);
    expect(JSON.parse(captured.stdout.trim())).toMatchObject({ action: 'created',
      deleted: 0,
      matchChanged: true });
    expect(hawk.rules.list(hawk.projectId)).toHaveLength(2);
  });

  it('--no-wait does not wait', async () => {
    const clock = createFakeClock();
    const { captured, io } = capture();

    expect(await runProvisionCommand(NO_WAIT, config, io, { clock,
      resolveAddress: async () => Promise.resolve(address()) })).toBe(0);
    expect(clock.pending()).toBe(0);
    expect(captured.stderr).not.toContain('waiting');
  });

  it('does not wait when the match did not change', async () => {
    const clock = createFakeClock();
    const resolveAddress = async (): Promise<PublicAddress> => Promise.resolve(address());

    await runProvisionCommand(NO_WAIT, config, capture().io, { clock,
      resolveAddress });

    const { captured, io } = capture();

    expect(await runProvisionCommand(WAIT, config, io, { clock,
      resolveAddress })).toBe(0);
    expect(JSON.parse(captured.stdout.trim())).toMatchObject({ action: 'none',
      matchChanged: false });
    expect(clock.pending()).toBe(0);
  });

  it('exit 1 with a class on failure', async () => {
    hawk.api.knobs.errors = Object.fromEntries([['CreateNotificationRule', { code: 'FORBIDDEN',
      message: 'Not enough permissions' }]]);

    const { captured, io } = capture();

    expect(await runProvisionCommand(NO_WAIT, config, io, { resolveAddress: async () => Promise.resolve(address()) })).toBe(1);
    expect(captured.stderr).toContain('failed api_forbidden: ');
    expect(captured.stdout).toBe('');
  });

  it('an unexpected exception is monitor_internal', async () => {
    const { captured, io } = capture();

    expect(await runProvisionCommand(NO_WAIT, config, io, { resolveAddress: async () => Promise.reject(new Error('boom')) })).toBe(1);
    expect(captured.stderr).toContain('failed monitor_internal: boom');
  });

  it('no secret or hostname in stdout and stderr', async () => {
    const secret = config.notifications.receiverSecret ?? '';
    const ok = capture();

    expect(await runProvisionCommand(NO_WAIT, config, ok.io, { resolveAddress: async () => Promise.resolve(address()) })).toBe(0);

    hawk.api.knobs.unresolvableHosts = [HOST];
    hawk.rules.list(hawk.projectId).forEach((rule) => {
      hawk.rules.remove(hawk.projectId, rule.id);
    });

    const failed = capture();

    expect(await runProvisionCommand(NO_WAIT, config, failed.io, { resolveAddress: async () => Promise.resolve(address('tunnel')) })).toBe(1);
    expect(failed.captured.stderr).toContain('failed tunnel_unavailable: ');

    for (const text of [ok.captured.stdout, ok.captured.stderr, failed.captured.stdout, failed.captured.stderr]) {
      expect(secret).not.toBe('');
      expect(text).not.toContain(secret);
      expect(text).not.toContain(HOST);
    }
  });

  it('missing secret is a config error', async () => {
    const { receiverSecret: omitted, ...rest } = config.notifications;
    const { captured, io } = capture();

    expect(omitted).toBeDefined();
    expect(await runProvisionCommand(NO_WAIT, { ...config,
      notifications: rest }, io)).toBe(1);
    expect(captured.stderr).toContain('RECEIVER_SECRET: is required for this command');
    expect(captured.stdout).toBe('');
  });
});
