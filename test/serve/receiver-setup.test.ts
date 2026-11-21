import { afterEach, describe, expect, it } from 'vitest';
import { createMutableRedactor } from '../../src/errors/redact.js';
import { sharedReceiver } from '../../src/serve/receiver-setup.js';
import { matchChangeOptions } from '../../src/serve/receiver-setup.js';
import { setupCheckNotification } from '../../src/serve/notification-setup.js';
import { buildRunners } from '../../src/serve/runners.js';
import type { Closer, RunnerContext } from '../../src/serve/scenario-setup.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../../src/storage/keys.js';
import { systemClock } from '../../src/time/clock.js';
import { TEST_RECEIVER_SECRET } from '../support/env.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { memoryLogger } from '../support/logger.js';
import { createTestDeps } from '../support/scenario.js';

const closers: Closer[] = [];
let hawk: FakeHawk | undefined;

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) {
    await close();
  }

  await hawk?.close();
  hawk = undefined;
});

/**
 * Builds the context of the runners for the notification scenarios.
 * @param overrides Replacements for the parts that talk to the outside.
 * @returns Context over a fake Hawk and an in-memory history.
 */
async function contextFor(overrides: RunnerContext['overrides'] = {}): Promise<RunnerContext> {
  hawk = await startFakeHawk();

  const { deps } = createTestDeps(hawk, { env: { SCENARIOS: 'check-notification',
    RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9100' } });

  return { config: { ...deps.config,
    notifications: { ...deps.config.notifications,
      receiverPort: 0 } },
  history: createHistory(openDatabase(':memory:')),
  clock: systemClock,
  logger: memoryLogger(),
  masking: createMutableRedactor([]),
  api: deps.api,
  collector: deps.collector,
  overrides,
  closers };
}

describe('sharedReceiver', () => {
  it('starts one receiver however many scenarios ask for it', async () => {
    const context = await contextFor();
    const first = await sharedReceiver(context);
    const second = await sharedReceiver(context);

    expect(second).toBe(first);
    expect(closers).toHaveLength(1);
  });

  it('is used by every notification setup: one port, one closer, one readiness check', async () => {
    const context = await contextFor();
    const one = await setupCheckNotification(context);
    const two = await setupCheckNotification(context);

    expect(two.receiverPort).toBe(one.receiverPort);
    expect(closers).toHaveLength(1);
    expect(two.readiness?.[0]).toBe(one.readiness?.[0]);
  });

  it('is ready only while the server listens, also when it was closed on its own', async () => {
    const context = await contextFor();
    const runtime = await sharedReceiver(context);
    const [check] = runtime.readiness ?? [];

    expect(await check?.run(new AbortController().signal)).toBe(true);
    await runtime.receiver.close();
    expect(await check?.run(new AbortController().signal)).toBe(false);
  });

  it('lists the readiness check of the receiver once in the built runners', async () => {
    const context = await contextFor();

    await setupCheckNotification(context);

    const built = await buildRunners(context);

    expect(built.readiness.map(check => check.name)).toEqual(['receiver']);
  });

  it('waits for the tunnel once for the process', async () => {
    let lookups = 0;
    const context = await contextFor({ resolveAddress: () => {
      lookups += 1;

      return Promise.reject(new Error('no tunnel yet'));
    },
    tunnelPollMs: 5 });
    const runtime = await sharedReceiver({ ...context,
      config: { ...context.config,
        monitoring: { ...context.config.monitoring,
          tunnelReadyTimeoutMs: 40 } } });
    const signal = new AbortController().signal;

    await runtime.waitForTunnel(signal);

    const afterFirst = lookups;

    expect(afterFirst).toBeGreaterThan(0);
    await runtime.waitForTunnel(signal);
    expect(lookups).toBe(afterFirst);
  });

  it('a wait that the first caller cancelled is not inherited: the next scenario waits for the tunnel itself', async () => {
    let lookups = 0;
    const context = await contextFor({ resolveAddress: () => {
      lookups += 1;

      return Promise.reject(new Error('no tunnel yet'));
    },
    tunnelPollMs: 5 });
    const runtime = await sharedReceiver({ ...context,
      config: { ...context.config,
        monitoring: { ...context.config.monitoring,
          tunnelReadyTimeoutMs: 60 } } });
    const cancelled = new AbortController();
    const first = runtime.waitForTunnel(cancelled.signal);

    await expect.poll(() => lookups).toBeGreaterThan(0);
    cancelled.abort();
    await first;

    const afterFirst = lookups;

    await runtime.waitForTunnel(new AbortController().signal);

    expect(lookups).toBeGreaterThan(afterFirst);

    // The second wait ran to its limit, so a third scenario does not wait again.
    const afterSecond = lookups;

    await runtime.waitForTunnel(new AbortController().signal);
    expect(lookups).toBe(afterSecond);
  });

  it('tunnelWaited is false before any wait, true after a wait that resolved, and stays false after a cancelled wait', async () => {
    const context = await contextFor({ resolveAddress: () => Promise.reject(new Error('no tunnel yet')),
      tunnelPollMs: 5 });
    const runtime = await sharedReceiver({ ...context,
      config: { ...context.config,
        monitoring: { ...context.config.monitoring,
          tunnelReadyTimeoutMs: 40 } } });

    expect(runtime.tunnelWaited()).toBe(false);

    const cancelled = new AbortController();
    const first = runtime.waitForTunnel(cancelled.signal);

    cancelled.abort();
    await first;
    expect(runtime.tunnelWaited()).toBe(false);

    await runtime.waitForTunnel(new AbortController().signal);
    expect(runtime.tunnelWaited()).toBe(true);
  });

  it('marks a late POST to /hooks/telegram as a late notification of that channel', async () => {
    const context = await contextFor();
    const { receiver } = await sharedReceiver(context);
    const { history } = context;

    history.startRun({ runId: 'rkkkkkkkkkkkkkkk',
      scenario: 'telegram-delivery',
      sequence: 1,
      trigger: 'schedule',
      startedAt: new Date(Date.now() - 3_600_000).toISOString() });
    history.finishRun('rkkkkkkkkkkkkkkk', { status: 'failed',
      finishedAt: new Date(Date.now() - 3_000_000).toISOString(),
      durationMs: 1000,
      degraded: [] });

    const body = `[e2e:${context.config.instanceId}] rkkkkkkkkkkkkkkk telegram-delivery`;
    const post = async (): Promise<Response> => fetch(`http://127.0.0.1:${String(receiver.port)}/hooks/telegram/${TEST_RECEIVER_SECRET}`, { method: 'POST',
      body });

    expect((await post()).status).toBe(200);
    await expect.poll(() => history.get('rkkkkkkkkkkkkkkk')?.lateNotificationAt).toBeDefined();
    expect(history.get('rkkkkkkkkkkkkkkk')?.lateNotificationChannel).toBe('telegram');

    await post();
    await expect.poll(() => history.get('rkkkkkkkkkkkkkkk')?.lateDuplicateNotificationAt).toBeDefined();
  });
});

describe('matchChangeOptions', () => {
  it('reads and writes the key it is given, apart from the other keys', async () => {
    const context = await contextFor();
    const { history } = context;
    const when = new Date('2026-03-01T10:00:00.000Z');

    history.setKv(MATCH_CHANGED_KEY, when.toISOString());

    expect(matchChangeOptions(context, MATCH_CHANGED_KEY).lastMatchChangeAtWallMs).toBe(when.getTime());
    expect(matchChangeOptions(context, TELEGRAM_MATCH_CHANGED_KEY).lastMatchChangeAtWallMs).toBeUndefined();

    matchChangeOptions(context, TELEGRAM_MATCH_CHANGED_KEY).onMatchChange(when.getTime() + 1000);

    expect(history.getKv(TELEGRAM_MATCH_CHANGED_KEY)).toBe(new Date(when.getTime() + 1000).toISOString());
    expect(history.getKv(MATCH_CHANGED_KEY)).toBe(when.toISOString());
  });
});
