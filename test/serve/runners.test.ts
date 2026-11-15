import { afterEach, describe, expect, it } from 'vitest';
import { createMutableRedactor } from '../../src/errors/redact.js';
import { StartupError } from '../../src/app.js';
import { buildRunners } from '../../src/serve/runners.js';
import type { Closer, RunnerContext } from '../../src/serve/scenario-setup.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
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
 * Builds the context of the runners for the given scenarios.
 * @param scenarios Comma-separated names the configuration enables.
 * @param env Variables that replace the test defaults; undefined removes one.
 * @returns Context over a fake Hawk and an in-memory history.
 */
async function contextFor(scenarios: string, env: Record<string, string | undefined> = {}): Promise<RunnerContext> {
  hawk = await startFakeHawk();

  const { deps } = createTestDeps(hawk, { env: { SCENARIOS: scenarios,
    RECEIVER_SECRET: TEST_RECEIVER_SECRET,
    TUNNEL_METRICS_URL: 'http://127.0.0.1:9100',
    ...env } });

  return { config: { ...deps.config,
    notifications: { ...deps.config.notifications,
      receiverPort: 0 } },
  history: createHistory(openDatabase(':memory:')),
  clock: systemClock,
  logger: memoryLogger(),
  masking: createMutableRedactor([]),
  api: deps.api,
  collector: deps.collector,
  overrides: {},
  closers };
}

describe('buildRunners', () => {
  it('builds a runner only for the scenarios of the configuration', async () => {
    const built = await buildRunners(await contextFor('send-and-receive-event'));

    expect(Object.keys(built.runners)).toEqual(['send-and-receive-event']);
    expect(built.beforeFirstRun).toEqual({});
    expect(built.readiness).toEqual([]);
    expect(built.receiverPort).toBeUndefined();
  });

  it('adds the receiver, its wait for the tunnel and its readiness check for check-notification', async () => {
    const built = await buildRunners(await contextFor('send-and-receive-event,check-notification'));

    expect(Object.keys(built.runners)).toEqual(['send-and-receive-event', 'check-notification']);
    expect(Object.keys(built.beforeFirstRun)).toEqual(['check-notification']);
    expect(built.readiness.map(check => check.name)).toEqual(['receiver']);
    expect(built.receiverPort).toBeGreaterThan(0);
    await expect(built.readiness[0]?.run(new AbortController().signal)).resolves.toBe(true);

    for (const close of closers.splice(0).toReversed()) {
      await close();
    }

    await expect(built.readiness[0]?.run(new AbortController().signal)).resolves.toBe(false);
  });

  it('names the missing variable when check-notification is chosen without the receiver secret', async () => {
    const context = await contextFor('check-notification', { RECEIVER_SECRET: undefined });
    const error: unknown = await buildRunners(context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).message).toContain('RECEIVER_SECRET');
  });

  it('names the address variables when check-notification has no address', async () => {
    const context = await contextFor('check-notification', { TUNNEL_METRICS_URL: undefined });
    const error: unknown = await buildRunners(context).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).message).toContain('PUBLIC_BASE_URL');
  });
});
