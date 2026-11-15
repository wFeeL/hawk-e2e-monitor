import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';
import { createRedactor } from '../../src/errors/redact.js';
import type { Redactor } from '../../src/errors/redact.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import type { RunRow } from '../../src/storage/types.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { startFakeNotify } from '../support/fake-notify.js';
import type { FakeNotify, FakeNotifyAnswer } from '../support/fake-notify.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';
import { runResultFixture } from '../support/run-result.js';
import { createAlerter } from '../../src/alerting/alerter.js';
import type { Alerter } from '../../src/alerting/alerter.js';
import { sendNotify } from '../../src/alerting/notify.js';

const START = new Date('2026-03-10T12:00:00.000Z');
const RETRY_MS = 60_000;
const HOUR_MS = 3_600_000;
const SCENARIO = 'send-and-receive-event';

/** Everything a test needs. */
interface Setup {
  /** Alerter under test. */
  alerter: Alerter;
  /** History behind it, not wrapped. */
  history: History;
  /** Fake bot. */
  bot: FakeNotify;
  /** Clock the alerter reads. */
  clock: FakeClock;
  /** Log of the alerter. */
  logger: MemoryLogger;
}

/** What a test may change. */
interface SetupOptions {
  /** First answer of the bot. */
  answer?: FakeNotifyAnswer;
  /** Time limit of one request. */
  httpTimeoutMs?: number;
  /** Send alerts to the log only. */
  noUrl?: boolean;
  /** Masks secrets. */
  redact?: Redactor;
  /** Wraps the history the alerter gets. */
  wrap?: (history: History) => History;
  /** Failed runs in a row that raise the alert. */
  threshold?: number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

/**
 * Builds the alerter on a fake bot and an in-memory history.
 * @param options Differences from the defaults.
 * @returns Alerter with its parts.
 */
async function setup(options: SetupOptions = {}): Promise<Setup> {
  const bot = await startFakeNotify(options.answer);
  const history = createHistory(openDatabase(':memory:'));
  const clock = createFakeClock({ wall: START });
  const logger = memoryLogger();
  const base = testConfig();
  const config: Config = { ...base,
    httpTimeoutMs: options.httpTimeoutMs ?? 3000,
    monitoring: { ...base.monitoring,
      ...options.noUrl === true ? {} : { alertNotifyUrl: bot.url },
      alertRetryMs: RETRY_MS,
      alertAfterFailures: options.threshold ?? 1 } };
  const alerter = createAlerter({ history: options.wrap?.(history) ?? history,
    logger,
    clock,
    redact: options.redact ?? (text => text),
    config });

  cleanups.push(async () => {
    await alerter.stop();
    await bot.close();
    history.close();
  });

  return { alerter,
    history,
    bot,
    clock,
    logger };
}

/**
 * Builds a finished run row.
 * @param clock Clock that gives the start time.
 * @param overrides Fields that replace a failed run.
 * @returns Run row.
 */
function failedRow(clock: FakeClock, overrides: Partial<RunRow> = {}): RunRow {
  return { id: 1,
    runId: 'raaaaaaaaaaaaaaaa',
    scenario: SCENARIO,
    sequence: 1,
    trigger: 'schedule',
    status: 'failed',
    startedAt: clock.wallTime().toISOString(),
    finishedAt: clock.wallTime().toISOString(),
    durationMs: 1000,
    failedStage: 'event_visible',
    errorClass: 'event_not_found',
    culprit: 'hawk',
    message: 'Event did not appear',
    degraded: [],
    stages: [],
    ...overrides };
}

/**
 * Builds a finished `ok` run row.
 * @param clock Clock that gives the start time.
 * @returns Run row.
 */
function okRow(clock: FakeClock): RunRow {
  return failedRow(clock, { status: 'ok',
    runId: 'rbbbbbbbbbbbbbbbb',
    sequence: 2 });
}

/**
 * Takes the messages the bot received.
 * @param bot Fake bot.
 * @returns The `message` fields in arrival order.
 */
function messages(bot: FakeNotify): string[] {
  return bot.requests.map(request => request.form.message ?? '');
}

const NO_RESULT: RunResult | undefined = undefined;
const SIGNAL = new AbortController().signal;

describe('alerter: delivery', () => {
  it('queues the transition, delivers it and marks it sent', async () => {
    const { alerter, bot, clock, history } = await setup();

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(1);
    expect(bot.requests).toHaveLength(0);

    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 1,
      failed: 0 });
    expect(messages(bot)).toHaveLength(1);
    expect(messages(bot)[0]).toContain('<b>FAILED</b> send-and-receive-event [e2e:test]');
    expect(bot.requests[0]?.form.parse_mode).toBe('HTML');
    expect(bot.requests[0]?.form.disable_web_page_preview).toBe('true');
    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(0);
    expect(history.oldestUnsentAlert()).toBeUndefined();
    expect(history.alertState(SCENARIO)?.state).toBe('failing');
  });

  it('a run that changes nothing queues nothing and returns undefined', async () => {
    const { alerter, clock, history } = await setup();

    expect(alerter.onRunFinished(okRow(clock), NO_RESULT)).toBeUndefined();
    expect(alerter.onRunFinished(failedRow(clock, { status: 'skipped',
      skipReason: 'overlap' }), NO_RESULT)).toBeUndefined();
    expect(history.oldestUnsentAlert()).toBeUndefined();
  });

  it('a 500 keeps the message queued and the next flush after the retry time delivers it', async () => {
    const { alerter, bot, clock, history } = await setup({ answer: { status: 500,
      body: 'oops' } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 0,
      failed: 1 });
    expect(history.oldestUnsentAlert()).toBeDefined();

    // Not due yet: nothing is sent.
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 0,
      failed: 0 });
    expect(bot.requests).toHaveLength(1);

    bot.setAnswer({});
    await clock.advance(RETRY_MS);
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 1,
      failed: 0 });
    expect(history.oldestUnsentAlert()).toBeUndefined();
  });

  it('the retry pause doubles with every attempt up to 10 minutes', async () => {
    const { alerter, bot, clock, history } = await setup({ answer: { status: 500 } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);

    for (const pause of [RETRY_MS, 2 * RETRY_MS, 4 * RETRY_MS, 8 * RETRY_MS, 600_000, 600_000]) {
      await alerter.flush(SIGNAL);
      expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(0);
      await clock.advance(pause - 1);
      expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(0);
      await clock.advance(1);
      expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(1);
    }

    expect(bot.requests).toHaveLength(6);
  });

  it('ok to failing to ok with a bot that answers 500 delivers FAILED then RECOVERED in order once it is fixed', async () => {
    const { alerter, bot, clock } = await setup({ answer: { status: 500 } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    await clock.advance(1000);
    expect(alerter.onRunFinished(okRow(clock), NO_RESULT)).toBe('recovered');
    await alerter.flush(SIGNAL);

    // The bot is back, but RECOVERED must not overtake the FAILED that is still waiting for its retry time.
    bot.setAnswer({});
    bot.requests.length = 0;
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 0,
      failed: 0 });
    expect(bot.requests).toHaveLength(0);

    await clock.advance(RETRY_MS);
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 2,
      failed: 0 });
    expect(messages(bot).map(text => /<b>([^<]+)<\/b>/u.exec(text)?.[1])).toEqual(['FAILED', 'RECOVERED']);
  });

  it('a hanging bot ends the flush at the time limit while onRunFinished returned at once', async () => {
    const { alerter, bot, clock, history } = await setup({ answer: { delayMs: 30_000 },
      httpTimeoutMs: 300 });

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 0,
      failed: 1 });
    expect(bot.requests).toHaveLength(1);
    expect(history.oldestUnsentAlert()).toBeDefined();
  });

  it('drops a message older than 24 hours with an error in the log and does not call the bot', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ answer: { status: 500 } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    await clock.advance(24 * HOUR_MS + 1);
    bot.requests.length = 0;
    await alerter.flush(SIGNAL);

    expect(bot.requests).toHaveLength(0);
    expect(history.oldestUnsentAlert()).toBeUndefined();
    expect(logger.lines.some(line => line.level === 'error' && line.msg === 'alert dropped')).toBe(true);
  });

  it('with no URL the text goes to the log as a warning and counts as sent', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ noUrl: true });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 1,
      failed: 0 });
    expect(bot.requests).toHaveLength(0);
    expect(history.oldestUnsentAlert()).toBeUndefined();
    expect(logger.lines.find(line => line.msg === 'alert')).toMatchObject({ level: 'warn',
      scenario: SCENARIO,
      text: expect.stringContaining('FAILED') as string });
  });

  it('a 404 keeps the message, counts rejections in a row and logs an error at the third', async () => {
    const { alerter, clock, logger } = await setup({ answer: { status: 404,
      body: 'no chat' } });
    const rejected = (): boolean => logger.lines.some(line => line.level === 'error' && line.msg === 'codex.bot rejected 3 alerts in a row; check ALERT_NOTIFY_URL');

    alerter.onRunFinished(failedRow(clock), NO_RESULT);

    for (const expected of [1, 2]) {
      await alerter.flush(SIGNAL);
      expect(alerter.health().rejectedInRow).toBe(expected);
      expect(rejected()).toBe(false);
      await clock.advance(600_000);
    }

    await alerter.flush(SIGNAL);
    expect(alerter.health().rejectedInRow).toBe(3);
    expect(rejected()).toBe(true);
  });

  it('a 5xx does not count as a rejection', async () => {
    const { alerter, clock } = await setup({ answer: { status: 500 } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    expect(alerter.health().rejectedInRow).toBe(0);
  });

  it('a success resets the rejections in a row, a network failure too', async () => {
    const { alerter, bot, clock } = await setup({ answer: { status: 404 } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    expect(alerter.health().rejectedInRow).toBe(1);
    bot.setAnswer({});
    await clock.advance(600_000);
    await alerter.flush(SIGNAL);
    expect(alerter.health().rejectedInRow).toBe(0);
  });

  it('reports the age of the oldest unsent message', async () => {
    const { alerter, clock } = await setup({ answer: { status: 500 } });

    expect(alerter.health()).toEqual({ backlogAgeMs: null,
      rejectedInRow: 0,
      storageFailing: false });
    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    await clock.advance(31 * 60_000);
    expect(alerter.health().backlogAgeMs).toBe(31 * 60_000);
  });

  it('the body of the form holds no secret, no tunnel host and no password', async () => {
    const secrets = ['hunter2-password', 'receiver-secret-0123456789abcdef', 'abc.trycloudflare.com'];
    const { alerter, bot, clock } = await setup({ redact: createRedactor(secrets) });

    alerter.onRunFinished(failedRow(clock, { message: `rejected ${secrets.join(' and ')}` }), runResultFixture({ warnings: [secrets[0] ?? ''] }));
    await alerter.flush(SIGNAL);

    const sent = JSON.stringify(bot.requests);

    expect(bot.requests).toHaveLength(1);
    for (const secret of secrets) {
      expect(sent).not.toContain(secret);
    }

    expect(sent).toContain('rejected *** and *** and ***');
  });
});

/** A switch a test flips. */
interface Switch {
  /** True while writes must fail. */
  broken: boolean;
}

describe('alerter: storage failure', () => {
  /**
   * Makes `saveAlert` throw while a switch is on.
   * @param state Holder of the switch.
   * @returns Wrapper for `SetupOptions.wrap`.
   */
  function breakable(state: Switch): (history: History) => History {
    return (history): History => ({ ...history,
      saveAlert: (...args): void => {
        if (state.broken) {
          throw new Error('disk full');
        }

        history.saveAlert(...args);
      } });
  }

  it('sends STORAGE FAILING and the alert directly, once per episode', async () => {
    const control = { broken: true };
    const { alerter, bot, clock, history } = await setup({ wrap: breakable(control) });

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });
    expect(messages(bot)[0]).toContain('STORAGE FAILING');
    expect(messages(bot)[0]).toContain('disk full');
    expect(messages(bot)[1]).toContain('<b>FAILED</b>');
    expect(history.oldestUnsentAlert()).toBeUndefined();
    expect(alerter.health().storageFailing).toBe(true);
    expect(alerter.failures()).toBeGreaterThan(0);

    // The next transition of the same episode: the alert only, from the state held in memory.
    expect(alerter.onRunFinished(failedRow(clock, { errorClass: 'collector_unavailable',
      failedStage: 'collector_availability',
      runId: 'rcccccccccccccccc' }), NO_RESULT)).toBe('still_failing');
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(3);
    });
    expect(messages(bot)[2]).toContain('STILL FAILING');

    control.broken = false;
    alerter.onRunFinished(okRow(clock), NO_RESULT);
    expect(alerter.health().storageFailing).toBe(false);
    await vi.waitFor(() => {
      expect(history.oldestUnsentAlert()).toBeDefined();
    });
  });

  it('a new episode of the failure announces itself again', async () => {
    const control = { broken: true };
    const { alerter, bot, clock } = await setup({ wrap: breakable(control) });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });
    control.broken = false;
    alerter.onRunFinished(failedRow(clock, { runId: 'rcccccccccccccccc' }), NO_RESULT);
    expect(alerter.health().storageFailing).toBe(false);
    control.broken = true;
    alerter.onRunFinished(okRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(4);
    });
    expect(messages(bot)[2]).toContain('STORAGE FAILING');
    expect(messages(bot)[3]).toContain('RECOVERED');
  });

  it('never throws, also when the state cannot be read', async () => {
    const { alerter, clock, logger } = await setup({ wrap: history => ({ ...history,
      alertState: () => {
        throw new Error('locked');
      } }) });

    expect(() => alerter.onRunFinished(failedRow(clock), NO_RESULT)).not.toThrow();
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
  });
});

describe('alerter: unreadable state and failing text', () => {
  it('an unreadable state still raises the alert directly, with STORAGE FAILING', async () => {
    const { alerter, bot, clock } = await setup({ wrap: history => ({ ...history,
      alertState: () => {
        throw new Error('locked');
      } }) });

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });
    expect(messages(bot)[0]).toContain('STORAGE FAILING');
    expect(messages(bot)[0]).toContain('locked');
    expect(messages(bot)[1]).toContain('<b>FAILED</b>');
    expect(alerter.health().storageFailing).toBe(true);
  });

  it('does not trust a state it could not read: every run starts from the database again', async () => {
    const { alerter, bot, clock, history } = await setup({ wrap: wrapped => ({ ...wrapped,
      alertState: () => {
        throw new Error('locked');
      } }) });

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    expect(alerter.onRunFinished(failedRow(clock, { runId: 'rcccccccccccccccc' }), NO_RESULT)).toBe('failed');
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(3);
    });
    expect(history.oldestUnsentAlert()).toBeUndefined();
  });

  it('sends RECOVERED after one failed read in the middle of a stored failing episode', async () => {
    const control = { broken: true };
    const { alerter, bot, clock, history } = await setup({ wrap: wrapped => ({ ...wrapped,
      alertState: (scenario) => {
        if (control.broken) {
          control.broken = false;
          throw new Error('locked');
        }

        return wrapped.alertState(scenario);
      } }) });

    alerter.start();
    history.saveAlert({ scenario: SCENARIO,
      state: 'failing',
      failureStreak: 3,
      lastClass: 'event_not_found',
      lastStage: 'event_visible',
      lastRunId: 'raaaaaaaaaaaaaaaa',
      episodeStartedAt: clock.wallTime().toISOString(),
      episodeFailures: 3,
      degraded: [],
      updatedAt: clock.wallTime().toISOString() });

    // The first read fails: ok after ok says nothing, and the derived state must not be kept.
    expect(alerter.onRunFinished(okRow(clock), NO_RESULT)).toBeUndefined();
    expect(alerter.onRunFinished(okRow(clock), NO_RESULT)).toBe('recovered');
    await vi.waitFor(() => {
      expect(messages(bot).some(message => message.includes('RECOVERED'))).toBe(true);
    });
  });

  it('a text that cannot be built still queues the transition with a plain message', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ redact: (text) => {
      if (text.includes('Event did not appear')) {
        throw new Error('redactor broke');
      }

      return text;
    } });

    alerter.start();
    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(1);
    });
    expect(messages(bot)[0]).toContain('FAILED');
    expect(messages(bot)[0]).toContain(SCENARIO);
    expect(messages(bot)[0]).toContain('could not be built');
    expect(logger.lines.some(line => line.level === 'error')).toBe(true);
    expect(history.alertState(SCENARIO)?.state).toBe('failing');
  });
});

describe('alerter: timer', () => {
  it('flushes right after a transition is queued, once started', async () => {
    const { alerter, bot, clock } = await setup();

    alerter.start();
    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(1);
    });
  });

  it('retries on the timer every alertRetryMs and stops cleanly', async () => {
    const { alerter, bot, clock, history } = await setup({ answer: { status: 500 } });

    alerter.start();
    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(clock.pending()).toBe(1);
    });

    bot.setAnswer({});
    await clock.advance(RETRY_MS);
    await vi.waitFor(() => {
      expect(history.oldestUnsentAlert()).toBeUndefined();
    });
    expect(bot.requests).toHaveLength(2);

    await alerter.stop();
    expect(clock.pending()).toBe(0);
    await alerter.stop();
  });

  it('does not flush by itself before start', async () => {
    const { alerter, bot, clock } = await setup();

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await clock.advance(RETRY_MS * 3);
    expect(bot.requests).toHaveLength(0);
  });
});

describe('alerter: injected send', () => {
  it('uses the send function it is given', async () => {
    const calls: string[] = [];
    const history = createHistory(openDatabase(':memory:'));
    const clock = createFakeClock({ wall: START });
    const alerter = createAlerter({ history,
      logger: memoryLogger(),
      clock,
      redact: text => text,
      config: testConfig({ monitoring: { ...testConfig().monitoring,
        alertNotifyUrl: 'https://notify.example.test/u/x' } }),
      send: async (url, text) => {
        calls.push(url);
        await Promise.resolve(text);
      } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    expect(calls).toEqual(['https://notify.example.test/u/x']);
    expect(sendNotify).toBeTypeOf('function');
    await alerter.stop();
    history.close();
  });
});
