import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlerterHealth } from '../../src/alerting/alerter.js';
import { createHeartbeat, heartbeatReason } from '../../src/heartbeat/heartbeat.js';
import type { HeartbeatInput } from '../../src/heartbeat/heartbeat.js';
import { createRedactor } from '../../src/errors/redact.js';
import type { SchedulerHealth } from '../../src/scheduler/scheduler.js';
import { createFakeClock } from '../support/fake-clock.js';
import { startFakeHealthchecks } from '../support/fake-healthchecks.js';
import type { FakeHealthchecks } from '../support/fake-healthchecks.js';
import { memoryLogger } from '../support/logger.js';
import { reservedPort } from '../support/ports.js';

const SEND = 'send-and-receive-event';
const NOTIFY = 'check-notification';
const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const MINUTE_MS = 60_000;
const FRESH_MS = 10 * MINUTE_MS;
const INTERVAL_MS = 10_000;
const WAIT = { timeout: 5000,
  interval: 10 };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

/**
 * Builds the input of `heartbeatReason` for a healthy monitor.
 * @param overrides Parts that differ from the healthy input.
 * @returns Input in which nothing is wrong.
 */
function healthy(overrides: Partial<HeartbeatInput> = {}): HeartbeatInput {
  const scheduler: SchedulerHealth = { scheduler: true,
    storage: true,
    stuck: [] };
  const alerts: AlerterHealth = { backlogAgeMs: null,
    rejectedInRow: 0,
    storageFailing: false };

  return { scheduler,
    alerts,
    scenarios: [SEND, NOTIFY],
    lastVerdictAt: () => NOW - MINUTE_MS,
    freshnessMs: () => FRESH_MS,
    nowWallMs: NOW,
    startedWallMs: NOW - 1000 * MINUTE_MS,
    ...overrides };
}

/**
 * Gives the reason text of `heartbeatReason`.
 * @param input What the heartbeat judges.
 * @returns The reason, or undefined when the monitor is healthy.
 */
function reasonOf(input: HeartbeatInput): string | undefined {
  return heartbeatReason(input)?.reason;
}

describe('heartbeatReason', () => {
  it('counts a scenario without a verdict from the first sighting when one is given', () => {
    const input = healthy({ lastVerdictAt: () => undefined,
      startedWallMs: NOW - MINUTE_MS,
      firstSeenAt: () => NOW - FRESH_MS - MINUTE_MS });

    expect(reasonOf(input)).toBe(`${SEND} has no verdict`);
    expect(reasonOf({ ...input,
      firstSeenAt: () => undefined })).toBeUndefined();
  });

  it('is undefined for a healthy monitor', () => {
    expect(reasonOf(healthy())).toBeUndefined();
  });

  it('is undefined when the last run failed, because a verdict is a verdict', () => {
    expect(reasonOf(healthy({ lastVerdictAt: () => NOW - 1000 }))).toBeUndefined();
  });

  it('names an unhealthy scheduler and failing history writes', () => {
    expect(reasonOf(healthy({ scheduler: { scheduler: false,
      storage: true,
      stuck: [] } }))).toBe('scheduler unhealthy');
    expect(reasonOf(healthy({ scheduler: { scheduler: true,
      storage: false,
      stuck: [] } }))).toBe('history writes fail');
    expect(reasonOf(healthy({ alerts: { backlogAgeMs: null,
      rejectedInRow: 0,
      storageFailing: true } }))).toBe('history writes fail');
  });

  it('names a scenario that stays busy', () => {
    expect(reasonOf(healthy({ scheduler: { scheduler: true,
      storage: true,
      stuck: [NOTIFY] } }))).toBe(`${NOTIFY} is stuck`);
  });

  it('names a scenario without a fresh verdict and the seconds it has been silent', () => {
    const skip = heartbeatReason(healthy({ lastVerdictAt: scenario => scenario === SEND ? NOW - FRESH_MS - 1000 : NOW }));

    expect(skip).toEqual({ reason: `${SEND} has no verdict`,
      silentSeconds: FRESH_MS / 1000 + 1 });
  });

  it('allows exactly the freshness limit', () => {
    expect(reasonOf(healthy({ lastVerdictAt: () => NOW - FRESH_MS }))).toBeUndefined();
  });

  it('counts a scenario with no verdict at all from the start of the process', () => {
    expect(reasonOf(healthy({ lastVerdictAt: () => undefined,
      startedWallMs: NOW - MINUTE_MS }))).toBeUndefined();
    expect(reasonOf(healthy({ lastVerdictAt: () => undefined,
      startedWallMs: NOW - FRESH_MS - MINUTE_MS }))).toBe(`${SEND} has no verdict`);
  });

  it('judges only the scenarios it is given, each by its own freshness', () => {
    const input = healthy({ scenarios: [NOTIFY],
      lastVerdictAt: scenario => scenario === SEND ? NOW - 1_000_000 : NOW });

    expect(reasonOf(input)).toBeUndefined();
    expect(reasonOf(healthy({ freshnessMs: scenario => scenario === NOTIFY ? 1000 : FRESH_MS,
      lastVerdictAt: () => NOW - MINUTE_MS }))).toContain(NOTIFY);
  });

  it('does not ask the probe for a verdict', () => {
    const input = healthy({ scenarios: [SEND, 'endpoints-probe'],
      lastVerdictAt: scenario => scenario === 'endpoints-probe' ? undefined : NOW,
      startedWallMs: NOW - 1000 * MINUTE_MS });

    expect(reasonOf(input)).toBeUndefined();
  });

  it('names alerts that are not delivered: a backlog over 30 minutes or 3 rejections in a row', () => {
    const limit = 30 * MINUTE_MS;

    expect(reasonOf(healthy({ alerts: { backlogAgeMs: limit,
      rejectedInRow: 0,
      storageFailing: false } }))).toBeUndefined();
    expect(reasonOf(healthy({ alerts: { backlogAgeMs: limit + MINUTE_MS,
      rejectedInRow: 0,
      storageFailing: false } }))).toBe('alerts are not delivered');
    expect(reasonOf(healthy({ alerts: { backlogAgeMs: null,
      rejectedInRow: 2,
      storageFailing: false } }))).toBeUndefined();
    expect(reasonOf(healthy({ alerts: { backlogAgeMs: null,
      rejectedInRow: 3,
      storageFailing: false } }))).toBe('alerts are not delivered');
  });
});

/** What the test tells the heartbeat about the health of the monitor. */
interface SkipState {
  /** Why not to ping; undefined means healthy. */
  reason: string | undefined;
  /** Seconds a scenario has been silent, which a reason may carry. */
  silentSeconds?: number;
}

/** A heartbeat on a fake clock and a fake service, with what the tests read. */
interface Rig {
  /** The heartbeat. */
  heartbeat: ReturnType<typeof createHeartbeat>;
  /** Fake service. */
  fake: FakeHealthchecks;
  /** Fake clock. */
  clock: ReturnType<typeof createFakeClock>;
  /** Log. */
  logger: ReturnType<typeof memoryLogger>;
  /** Reason the tests set; undefined means healthy. */
  state: SkipState;
  /** Calls of `onFailure`. */
  failures: ReturnType<typeof vi.fn<() => void>>;
}

/**
 * Builds a heartbeat that pings a fake service.
 * @param url Address to ping; the fake service by default.
 * @returns The heartbeat with its parts.
 */
async function rig(url?: string): Promise<Rig> {
  const fake = await startFakeHealthchecks();
  const clock = createFakeClock();
  const logger = memoryLogger();
  const state: SkipState = { reason: undefined };
  const failures = vi.fn<() => void>();
  const target = url ?? fake.url;
  const heartbeat = createHeartbeat({ url: target,
    clock,
    logger,
    redact: createRedactor([target, new URL(target).pathname]),
    httpTimeoutMs: 1000,
    intervalMs: INTERVAL_MS,
    reasonToSkip: () => state.reason === undefined
      ? undefined
      : { reason: state.reason,
          ...state.silentSeconds === undefined ? {} : { silentSeconds: state.silentSeconds } },
    onFailure: failures });

  cleanups.push(async () => {
    heartbeat.stop();
    await fake.close();
  });

  return { heartbeat,
    fake,
    clock,
    logger,
    state,
    failures };
}

describe('beatOnce', () => {
  it('pings and says so when the monitor is healthy', async () => {
    const { heartbeat, fake } = await rig();

    expect(await heartbeat.beatOnce(new AbortController().signal)).toBe('sent');
    expect(fake.pings).toBe(1);
  });

  it('does not ping while there is a reason, and logs the reason once per change', async () => {
    const { heartbeat, fake, logger, state } = await rig();
    const signal = new AbortController().signal;

    state.reason = 'alerts are not delivered';
    expect(await heartbeat.beatOnce(signal)).toBe('skipped');
    expect(await heartbeat.beatOnce(signal)).toBe('skipped');
    expect(fake.pings).toBe(0);
    expect(logger.lines.filter(line => line.level === 'warn' && String(line.msg).includes('alerts are not delivered'))).toHaveLength(1);

    state.reason = 'scheduler unhealthy';
    await heartbeat.beatOnce(signal);
    expect(logger.lines.filter(line => line.level === 'warn')).toHaveLength(2);

    state.reason = undefined;
    expect(await heartbeat.beatOnce(signal)).toBe('sent');

    state.reason = 'scheduler unhealthy';
    await heartbeat.beatOnce(signal);
    expect(logger.lines.filter(line => line.level === 'warn')).toHaveLength(3);
  });

  it('logs a reason once while only the silent seconds in it grow, and puts them in a field', async () => {
    const { heartbeat, logger, state } = await rig();
    const signal = new AbortController().signal;

    state.reason = `${SEND} has no verdict`;

    for (const seconds of [601, 611, 621]) {
      state.silentSeconds = seconds;
      expect(await heartbeat.beatOnce(signal)).toBe('skipped');
    }

    const warnings = logger.lines.filter(line => line.level === 'warn');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ msg: `heartbeat is not sent: ${SEND} has no verdict`,
      silentSeconds: 601 });
  });

  it('fails on an answer other than 2xx, calls onFailure and tries again the next time', async () => {
    const { heartbeat, fake, failures } = await rig();
    const signal = new AbortController().signal;

    fake.setStatus(500);
    expect(await heartbeat.beatOnce(signal)).toBe('failed');
    expect(failures).toHaveBeenCalledTimes(1);
    // No retry inside one beat.
    expect(fake.pings).toBe(1);

    fake.setStatus(200);
    expect(await heartbeat.beatOnce(signal)).toBe('sent');
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('fails when the service is not reachable', async () => {
    const { heartbeat, failures } = await rig(`http://127.0.0.1:${String(await reservedPort())}/ping/gone`);

    expect(await heartbeat.beatOnce(new AbortController().signal)).toBe('failed');
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('never writes the address of the ping or its path into the log', async () => {
    const { heartbeat, fake, logger } = await rig();
    const signal = new AbortController().signal;

    fake.setStatus(503);
    await heartbeat.beatOnce(signal);
    await fake.close();
    await heartbeat.beatOnce(signal);

    const text = JSON.stringify(logger.lines);

    expect(logger.lines.some(line => line.level === 'warn')).toBe(true);
    expect(text).not.toContain(fake.key);
    expect(text).not.toContain(fake.url);
  });

  it('fails without waiting longer than the HTTP timeout', async () => {
    const { heartbeat, fake } = await rig();
    const controller = new AbortController();

    controller.abort();
    expect(await heartbeat.beatOnce(controller.signal)).toBe('failed');
    expect(fake.pings).toBe(0);
  });
});

describe('start and stop', () => {
  it('pings every interval while healthy and stops pinging after stop', async () => {
    const { heartbeat, fake, clock } = await rig();

    heartbeat.start();
    await clock.advance(INTERVAL_MS);
    await vi.waitFor(() => {
      expect(fake.pings).toBe(1);
    }, WAIT);
    await clock.advance(INTERVAL_MS);
    await vi.waitFor(() => {
      expect(fake.pings).toBe(2);
    }, WAIT);

    heartbeat.stop();
    await clock.advance(INTERVAL_MS * 3);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(fake.pings).toBe(2);
  });

  it('keeps ticking after a failed ping and pings again at the next tick', async () => {
    const { heartbeat, fake, clock, failures } = await rig();

    fake.setStatus(500);
    heartbeat.start();
    await clock.advance(INTERVAL_MS);
    await vi.waitFor(() => {
      expect(failures).toHaveBeenCalledTimes(1);
    }, WAIT);

    fake.setStatus(200);
    await clock.advance(INTERVAL_MS);
    await vi.waitFor(() => {
      expect(fake.pings).toBe(2);
    }, WAIT);
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('does not ping while the monitor has a reason not to', async () => {
    const { heartbeat, fake, clock, state } = await rig();

    state.reason = 'scheduler unhealthy';
    heartbeat.start();
    await clock.advance(INTERVAL_MS * 3);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(fake.pings).toBe(0);
  });
});
