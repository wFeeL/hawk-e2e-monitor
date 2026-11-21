import { afterEach, describe, expect, it } from 'vitest';
import type { Alerter } from '../../src/alerting/alerter.js';
import { scenarioSettings } from '../../src/config/scenario.js';
import { createRedactor } from '../../src/errors/redact.js';
import type { Scheduler } from '../../src/scheduler/scheduler.js';
import { createServeHeartbeat } from '../../src/serve/heartbeat-setup.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import { heartbeatFirstSeenKey } from '../../src/storage/keys.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { startFakeHealthchecks } from '../support/fake-healthchecks.js';
import type { FakeHealthchecks } from '../support/fake-healthchecks.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';

const SEND = 'send-and-receive-event' as const;
const T = new Date('2026-03-10T12:00:00.000Z');
const SECOND_MS = 1000;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/** One process of the monitor as far as the heartbeat sees it. */
interface Process {
  /** Clock of the process. */
  clock: FakeClock;
  /** Log of the heartbeat. */
  logger: MemoryLogger;
  /** Makes one beat. */
  beat: () => Promise<string>;
}

/**
 * Builds the heartbeat of a process that starts at a given moment.
 * @param history History shared by the processes, the home of `kv`.
 * @param url Address to ping.
 * @param startAt Wall-clock moment the process starts.
 * @param verdictAt Wall-clock end of the last verdict of the scenario, if any.
 * @returns The clock, the log and a beat function.
 */
function processAt(history: History, url: string, startAt: Date, verdictAt?: () => number | undefined): Process {
  const clock = createFakeClock({ wall: startAt });
  const logger = memoryLogger();
  const base = testConfig();
  // The test config allows a ping 100 ms, which a loaded machine misses.
  const config = { ...base,
    httpTimeoutMs: 5000,
    monitoring: { ...base.monitoring,
      scenarios: [SEND],
      heartbeat: { url,
        intervalMs: 10_000 } } };
  const scheduler = { health: () => ({ scheduler: true,
    storage: true,
    stuck: [] }),
  lastVerdictAt: () => verdictAt?.() } as unknown as Scheduler;
  const alerter = { health: () => ({ backlogAgeMs: null,
    rejectedInRow: 0,
    storageFailing: false }) } as unknown as Alerter;
  const heartbeat = createServeHeartbeat({ config,
    clock,
    logger,
    redact: createRedactor([]),
    scheduler,
    alerter,
    kv: history,
    metrics: { heartbeatFailed: () => undefined } as never });

  if (heartbeat === undefined) {
    throw new Error('heartbeat expected');
  }

  return { clock,
    logger,
    beat: async () => heartbeat.beatOnce(new AbortController().signal) };
}

/**
 * Gives how long a verdict stays fresh.
 * @returns Interval plus watchdog of the scenario.
 */
function freshnessMs(): number {
  const settings = scenarioSettings(testConfig(), SEND);

  return settings.intervalMs + settings.watchdogMs;
}

describe('createServeHeartbeat: first sighting of a scenario', () => {
  it('keeps counting from the first start when the process restarts, so a crash loop goes stale', async () => {
    const history = createHistory(openDatabase(':memory:'));
    const fresh = freshnessMs();

    processAt(history, 'http://127.0.0.1:9/ping/x', T);

    const second = processAt(history, 'http://127.0.0.1:9/ping/x', new Date(T.getTime() + fresh - 10 * SECOND_MS));

    await second.clock.advance(11 * SECOND_MS);
    expect(await second.beat()).toBe('skipped');
    expect(second.logger.lines.some(line => line.msg === `heartbeat is not sent: ${SEND} has no verdict`)).toBe(true);
  });

  it('is not stale before the window of the first start has passed', async () => {
    const history = createHistory(openDatabase(':memory:'));
    const check: FakeHealthchecks = await startFakeHealthchecks();

    cleanups.push(async () => check.close());
    processAt(history, check.url, T);

    const second = processAt(history, check.url, new Date(T.getTime() + freshnessMs() - 10 * SECOND_MS));

    expect(await second.beat()).toBe('sent');
  });

  it('ignores the stored sighting once a verdict exists, and deletes it', async () => {
    const history = createHistory(openDatabase(':memory:'));
    const check = await startFakeHealthchecks();
    const fresh = freshnessMs();

    cleanups.push(async () => check.close());
    processAt(history, check.url, T);

    const verdictAt = T.getTime() + 5 * SECOND_MS;
    const second = processAt(history, check.url, new Date(T.getTime() + fresh - 10 * SECOND_MS), () => verdictAt);

    await second.clock.advance(11 * SECOND_MS);
    expect(await second.beat()).toBe('sent');
    expect(history.getKv(heartbeatFirstSeenKey(SEND))).toBeUndefined();
  });

  it('removes the stored sighting of a scenario that is no longer configured', () => {
    const history = createHistory(openDatabase(':memory:'));

    history.setKv(heartbeatFirstSeenKey('check-notification'), T.toISOString());
    processAt(history, 'http://127.0.0.1:9/ping/x', T);
    expect(history.getKv(heartbeatFirstSeenKey('check-notification'))).toBeUndefined();
    expect(history.getKv(heartbeatFirstSeenKey(SEND))).toBe(T.toISOString());
  });

  it('falls back to the start of the process when kv cannot be used', async () => {
    const real = createHistory(openDatabase(':memory:'));
    const history: History = { ...real,
      updateKv: () => {
        throw new Error('disk full');
      } };
    const check = await startFakeHealthchecks();

    cleanups.push(async () => check.close());

    const only = processAt(history, check.url, T);

    expect(await only.beat()).toBe('sent');
    expect(only.logger.lines.some(line => line.level === 'warn')).toBe(true);
  });
});
