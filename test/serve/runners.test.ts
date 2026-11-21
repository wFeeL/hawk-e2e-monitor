import { afterEach, describe, expect, it } from 'vitest';
import { createMutableRedactor } from '../../src/errors/redact.js';
import { StartupError } from '../../src/app.js';
import { buildRunners } from '../../src/serve/runners.js';
import type { Closer, RunnerContext } from '../../src/serve/scenario-setup.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { systemClock } from '../../src/time/clock.js';
import { httpAddress } from '../support/address.js';
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
 * @param overrides Test replacements of the parts that talk to the outside.
 * @returns Context over a fake Hawk and an in-memory history.
 */
async function contextFor(scenarios: string, env: Record<string, string | undefined> = {}, overrides: RunnerContext['overrides'] = {}): Promise<RunnerContext> {
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
  overrides,
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

  it('builds the runner of new-project over the history, with no receiver and no wait', async () => {
    const context = await contextFor('new-project');
    const built = await buildRunners(context);

    expect(Object.keys(built.runners)).toEqual(['new-project']);
    expect(built.beforeFirstRun).toEqual({});
    expect(built.readiness).toEqual([]);
    expect(built.receiverPort).toBeUndefined();

    const result = await built.runners['new-project']?.({ runId: 'raaaaaaaaaaaaaaaa',
      sequence: 1,
      signal: new AbortController().signal });

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'new-project',
      runId: 'raaaaaaaaaaaaaaaa' });
    expect(context.history.getKv('new-project:created')).toBeUndefined();
  });

  it('records the project in the history while the run is on', async () => {
    const context = await contextFor('new-project');
    const built = await buildRunners(context);
    const seen: Array<string | undefined> = [];

    if (hawk !== undefined) {
      hawk.collector.knobs.holdReply = async () => {
        seen.push(context.history.getKv('new-project:created'));

        return Promise.resolve();
      };
    }

    await built.runners['new-project']?.({ runId: 'raaaaaaaaaaaaaaab',
      sequence: 1,
      signal: new AbortController().signal });

    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] ?? 'null')).toHaveLength(1);
  });

  it('builds the runner of sourcemaps over the clients, with no receiver and no wait', async () => {
    const built = await buildRunners(await contextFor('sourcemaps'));

    expect(Object.keys(built.runners)).toEqual(['sourcemaps']);
    expect(built.beforeFirstRun).toEqual({});
    expect(built.readiness).toEqual([]);
    expect(built.receiverPort).toBeUndefined();

    const result = await built.runners.sourcemaps?.({ runId: 'raaaaaaaaaaaaaaac',
      sequence: 1,
      signal: new AbortController().signal });

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'sourcemaps',
      runId: 'raaaaaaaaaaaaaaac' });
  });

  it('builds the runner of sentry-envelope over the clients, with no receiver and no wait', async () => {
    const built = await buildRunners(await contextFor('sentry-envelope'));

    expect(Object.keys(built.runners)).toEqual(['sentry-envelope']);
    expect(built.beforeFirstRun).toEqual({});
    expect(built.readiness).toEqual([]);

    const result = await built.runners['sentry-envelope']?.({ runId: 'raaaaaaaaaaaaaaad',
      sequence: 1,
      signal: new AbortController().signal });

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'sentry-envelope' });
  });

  it('starts the wait for the tunnel when the probe is set up beside a notification scenario, before any run', async () => {
    let lookups = 0;

    await buildRunners(await contextFor('endpoints-probe,check-notification', {}, { resolveAddress: () => {
      lookups += 1;

      return Promise.reject(new Error('no tunnel yet'));
    },
    tunnelPollMs: 5 }));

    await expect.poll(() => lookups).toBeGreaterThan(0);
  });

  it('gives the probe the receiver stage when a notification scenario is enabled', async () => {
    // The receiver listens on a port of its own, known once the runners are built.
    let port = 0;

    const built = await buildRunners(await contextFor('endpoints-probe,check-notification', {}, { resolveAddress: async () => Promise.resolve(httpAddress(port)),
      tunnelPollMs: 5 }));

    port = built.receiverPort ?? 0;
    await built.beforeFirstRun['check-notification']?.(new AbortController().signal);

    const result = await built.runners['endpoints-probe']?.({ runId: 'raaaaaaaaaaaaaaae',
      sequence: 1,
      signal: new AbortController().signal });

    expect(result?.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['collector_availability', 'ok'],
      ['api_availability', 'ok'],
      ['receiver_availability', 'ok'],
    ]);
  });

  it('gives the probe no receiver stage and no tunnel lookup without a notification scenario', async () => {
    let lookups = 0;
    const built = await buildRunners(await contextFor('endpoints-probe', {}, { resolveAddress: () => {
      lookups += 1;

      return Promise.reject(new Error('unused'));
    } }));
    const result = await built.runners['endpoints-probe']?.({ runId: 'raaaaaaaaaaaaaaaf',
      sequence: 1,
      signal: new AbortController().signal });

    expect(result?.stages.map(stage => stage.name)).toEqual(['collector_availability', 'api_availability']);
    expect(lookups).toBe(0);
    expect(built.receiverPort).toBeUndefined();
  });
});
