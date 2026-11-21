import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInternalServer } from '../../src/http/internal-server.js';
import { manualRunHandler } from '../../src/serve/manual-runs.js';
import type { ManualRunsDeps } from '../../src/serve/manual-runs.js';
import type { StartedRun } from '../../src/scheduler/scheduler.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import type { RunWithResult } from '../../src/storage/types.js';
import type { RunRow } from '../../src/storage/types.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { memoryLogger } from '../support/logger.js';
import { runResultFixture } from '../support/run-result.js';

const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';
const TOKEN = 'manual-token-0123456789-0123456789';
const MIN_INTERVAL_MS = 60_000;
// RUN 3000 + CLEANUP 600 + grace 30000 of the test configuration.
const WATCHDOG_MS = 33_600;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async server => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  })));
});

/** The scheduler the handler talks to, with what the tests read and set. */
interface StubScheduler {
  /** Run id the scheduler reports as going; undefined when idle. */
  running: string | undefined;
  /** Calls of `runNow`. */
  runNow: ReturnType<typeof vi.fn<ManualRunsDeps['scheduler']['runNow']>>;
  /** Resolves the `done` of the last started run. */
  finish: (row: RunRow) => void;
}

/** A handler behind a real server. */
interface Rig {
  /** Posts to a path with the right token unless told otherwise. */
  post: (path: string, headers?: Record<string, string>) => Promise<Response>;
  /** The scheduler stub. */
  scheduler: StubScheduler;
  /** History the handler reads. */
  history: History;
  /** Fake clock of the handler. */
  clock: FakeClock;
}

/** What a test may change. */
interface RigOptions {
  /** Least time between manual runs, 60 s by default. */
  minIntervalMs?: number;
  /** Scenarios of the configuration. */
  scenarios?: Array<typeof NOTIFY | typeof SEND>;
}

/**
 * Starts the handler on a random port with a stub scheduler and a fake clock.
 * @param options Differences from the defaults.
 * @returns The way to call it and the parts.
 */
async function rig(options: RigOptions = {}): Promise<Rig> {
  const base = testConfig();
  const config = { ...base,
    monitoring: { ...base.monitoring,
      scenarios: options.scenarios ?? [SEND],
      manual: { token: TOKEN,
        minIntervalMs: options.minIntervalMs ?? MIN_INTERVAL_MS } } };
  const clock = createFakeClock();
  const history = createHistory(openDatabase(':memory:'));
  let resolveDone: (row: RunRow) => void = () => undefined;
  let counter = 0;
  const scheduler: StubScheduler = { running: undefined,
    runNow: vi.fn<ManualRunsDeps['scheduler']['runNow']>((_scenario, _trigger) => {
      counter += 1;

      const runId = `r${String.fromCodePoint(96 + counter).repeat(16)}`;
      const done = new Promise<RunRow>((resolve) => {
        resolveDone = resolve;
      });
      const started: StartedRun = { started: true,
        runId,
        done };

      return started;
    }),
    finish: (row) => {
      resolveDone(row);
    } };
  const handler = manualRunHandler({ scheduler: { runNow: scheduler.runNow,
    status: () => [{ scenario: SEND,
      storageFailed: false,
      ...scheduler.running === undefined ? {} : { runningRunId: scheduler.running } }] },
  history,
  config,
  clock });
  const server = createInternalServer({ logger: memoryLogger(),
    liveness: [],
    readiness: [],
    checkTimeoutMs: 100,
    clock,
    routes: new Map([['POST /runs/*', handler]]) });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const base_ = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return { post: async (path, headers = Object.fromEntries([['authorization', `Bearer ${TOKEN}`]])) => fetch(`${base_}${path}`, { method: 'POST',
    headers }),
  scheduler,
  history,
  clock };
}

describe('POST /runs/<scenario>: refusals', () => {
  it('answers 401 with a Bearer challenge for a missing, wrong or malformed token, and starts nothing', async () => {
    const { post, scheduler } = await rig();

    for (const headers of [{},
      Object.fromEntries([['authorization', 'Bearer wrong']]),
      Object.fromEntries([['authorization', TOKEN]]),
      Object.fromEntries([['authorization', `Basic ${TOKEN}`]]),
      Object.fromEntries([['authorization', `Bearer ${TOKEN}x`]])]) {
      const response = await post(`/runs/${SEND}`, headers);

      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.json()).toEqual({ error: 'unauthorized' });
    }

    expect(scheduler.runNow).not.toHaveBeenCalled();
  });

  it('checks the token before the name, so an unknown name is not revealed to a stranger', async () => {
    const { post } = await rig();

    expect((await post('/runs/nothing', {})).status).toBe(401);
  });

  it('answers 404 for an unknown scenario, a scenario that is not enabled and an empty name', async () => {
    const { post, scheduler } = await rig();

    for (const path of ['/runs/nothing', `/runs/${NOTIFY}`, '/runs/', '/runs/%E0%A4%A']) {
      const response = await post(path);

      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'not_found' });
    }

    expect(scheduler.runNow).not.toHaveBeenCalled();
  });

  it('answers 409 with the running run when the scenario is busy', async () => {
    const { post, scheduler } = await rig();

    scheduler.running = 'rbusybusybusybusy';

    const response = await post(`/runs/${SEND}`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ runningRunId: 'rbusybusybusybusy' });
    expect(scheduler.runNow).not.toHaveBeenCalled();
  });

  it('answers 503 while the scheduler is stopping', async () => {
    const { post, scheduler } = await rig();

    scheduler.runNow.mockReturnValueOnce({ started: false,
      stopped: true });

    const response = await post(`/runs/${SEND}`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'stopping' });
  });

  it('answers 429 with Retry-After in whole seconds, rounded up, for a second manual run too soon', async () => {
    const { post, scheduler, clock } = await rig();

    expect((await post(`/runs/${SEND}`)).status).toBe(202);
    await clock.advance(MIN_INTERVAL_MS - 1500);

    const response = await post(`/runs/${SEND}`);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(scheduler.runNow).toHaveBeenCalledTimes(1);

    await clock.advance(1500);
    expect((await post(`/runs/${SEND}`)).status).toBe(202);
    expect(scheduler.runNow).toHaveBeenCalledTimes(2);
  });

  it('answers 409 before 429 when the scenario is busy and the last manual run is recent', async () => {
    const { post, scheduler } = await rig();

    await post(`/runs/${SEND}`);
    scheduler.running = 'rbusybusybusybusy';

    expect((await post(`/runs/${SEND}`)).status).toBe(409);
  });

  it('allows runs back to back when the least time is 0', async () => {
    const { post } = await rig({ minIntervalMs: 0 });

    expect((await post(`/runs/${SEND}`)).status).toBe(202);
    expect((await post(`/runs/${SEND}`)).status).toBe(202);
  });
});

describe('POST /runs/<scenario>: accepted', () => {
  it('starts a manual run and answers 202 with its id', async () => {
    const { post, scheduler } = await rig();
    const response = await post(`/runs/${SEND}`);

    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ runId: 'raaaaaaaaaaaaaaaa' });
    expect(scheduler.runNow).toHaveBeenCalledWith(SEND, 'manual');
  });

  it('with ?wait=true answers 200 with the stored row and its result once the run is done', async () => {
    const { post, scheduler, history } = await rig();

    history.startRun({ runId: 'raaaaaaaaaaaaaaaa',
      scenario: SEND,
      sequence: 1,
      trigger: 'manual',
      startedAt: '2026-03-10T10:00:00.000Z' });

    const pending = post(`/runs/${SEND}?wait=true`);

    await vi.waitFor(() => {
      expect(scheduler.runNow).toHaveBeenCalled();
    });
    history.finishRun('raaaaaaaaaaaaaaaa', { status: 'ok',
      finishedAt: '2026-03-10T10:00:05.000Z',
      durationMs: 5000,
      degraded: [],
      result: runResultFixture({ runId: 'raaaaaaaaaaaaaaaa' }) });

    const stored = history.get('raaaaaaaaaaaaaaaa');

    scheduler.finish(stored ?? ({} as RunRow));

    const response = await pending;
    const body = await response.json() as RunWithResult;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ runId: 'raaaaaaaaaaaaaaaa',
      trigger: 'manual',
      status: 'ok' });
    expect(body.result?.runId).toBe('raaaaaaaaaaaaaaaa');
  });

  it('with ?wait=true gives up at the watchdog of the scenario and answers 202 with the run id', async () => {
    const { post, scheduler, clock } = await rig();
    const pending = post(`/runs/${SEND}?wait=true`);

    await vi.waitFor(() => {
      expect(scheduler.runNow).toHaveBeenCalled();
    });
    await clock.advance(WATCHDOG_MS - 1);
    await clock.advance(1);

    const response = await pending;

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 'raaaaaaaaaaaaaaaa' });
  });

  it('with ?wait=false or anything else does not wait', async () => {
    const { post } = await rig({ minIntervalMs: 0 });

    expect((await post(`/runs/${SEND}?wait=false`)).status).toBe(202);
    expect((await post(`/runs/${SEND}?wait=yes`)).status).toBe(202);
  });
});
