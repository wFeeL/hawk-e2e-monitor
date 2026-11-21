import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';
import { createRedactor } from '../../src/errors/redact.js';
import type { Redactor } from '../../src/errors/redact.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import type { AlertStateRow, RunRow } from '../../src/storage/types.js';
import type { ScenarioName } from '../../src/scenarios/names.js';
import { SCENARIO_NAMES } from '../../src/scenarios/names.js';
import { tempDatabase } from '../support/database.js';
import { testConfig } from '../support/config.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { startFakeNotify } from '../support/fake-notify.js';
import type { FakeNotify, FakeNotifyAnswer } from '../support/fake-notify.js';
import { memoryLogger } from '../support/logger.js';
import type { MemoryLogger } from '../support/logger.js';
import { runResultFixture } from '../support/run-result.js';
import { createAlerter } from '../../src/alerting/alerter.js';
import { heartbeatReason } from '../../src/heartbeat/heartbeat.js';
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
  /** Failed probes in a row that raise the alert. */
  probeThreshold?: number;
  /** History file; `:memory:` by default. */
  database?: string;
  /** Scenarios of the monitor; the defaults when absent. */
  scenarios?: readonly ScenarioName[];
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
  const history = createHistory(openDatabase(options.database ?? ':memory:'));
  const clock = createFakeClock({ wall: START });
  const logger = memoryLogger();
  const base = testConfig();
  const config: Config = { ...base,
    httpTimeoutMs: options.httpTimeoutMs ?? 3000,
    monitoring: { ...base.monitoring,
      ...options.scenarios === undefined ? {} : { scenarios: [...options.scenarios] },
      ...options.noUrl === true ? {} : { alertNotifyUrl: bot.url },
      alertRetryMs: RETRY_MS,
      alertAfterFailures: options.threshold ?? 1,
      probe: { ...base.monitoring.probe,
        alertAfterFailures: options.probeThreshold ?? base.monitoring.probe.alertAfterFailures } } };
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
    sequence: 3,
    stages: [{ name: 'event_visible',
      status: 'ok',
      durationMs: 1 }] });
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

describe('alerter: degraded', () => {
  it('an ok run with an unconfirmed accept after an ok run sends DEGRADED naming the code', async () => {
    const { alerter, clock, bot } = await setup();

    expect(alerter.onRunFinished(okRow(clock), NO_RESULT)).toBeUndefined();
    expect(alerter.onRunFinished({ ...okRow(clock),
      runId: 'rcccccccccccccccc',
      degraded: ['accept_uncertain'] }, NO_RESULT)).toBe('degraded');
    await alerter.flush(SIGNAL);

    expect(messages(bot)).toHaveLength(1);
    expect(messages(bot)[0]).toContain('DEGRADED');
    expect(messages(bot)[0]).toContain('accept_uncertain');
  });
});

describe('alerter: threshold per scenario', () => {
  it('raises the alert of the probe after its own number of failures in a row, and of another scenario after theirs', async () => {
    const { alerter, clock, bot } = await setup({ threshold: 1,
      probeThreshold: 3 });
    const probeFailure = (sequence: number): RunRow => failedRow(clock, { scenario: 'endpoints-probe',
      sequence,
      runId: `r${String.fromCodePoint(96 + sequence).repeat(16)}`,
      failedStage: 'garage_availability',
      errorClass: 'garage_unavailable' });

    expect(alerter.onRunFinished(probeFailure(1), NO_RESULT)).toBeUndefined();
    expect(alerter.onRunFinished(probeFailure(2), NO_RESULT)).toBeUndefined();
    // A failure of another scenario is not held back by the threshold of the probe.
    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    expect(alerter.onRunFinished(probeFailure(3), NO_RESULT)).toBe('failed');
    await alerter.flush(SIGNAL);

    expect(messages(bot)).toHaveLength(2);
    expect(messages(bot).filter(text => text.includes('endpoints-probe'))).toHaveLength(1);
  });

  it('one failed probe alerts nothing and a good one in between starts the count again', async () => {
    const { alerter, clock, bot } = await setup({ probeThreshold: 3 });
    const probe = (status: RunRow['status'], sequence: number): RunRow => failedRow(clock, { scenario: 'endpoints-probe',
      status,
      failedStage: 'garage_availability',
      sequence,
      runId: `r${String.fromCodePoint(96 + sequence).repeat(16)}` });

    for (const [index, status] of (['failed', 'failed', 'ok', 'failed', 'failed'] as const).entries()) {
      expect(alerter.onRunFinished(probe(status, index + 1), NO_RESULT)).toBeUndefined();
    }

    await alerter.flush(SIGNAL);
    expect(bot.requests).toHaveLength(0);
  });
});

describe('alerter: delivery', () => {
  it('queues the transition, delivers it and marks it sent', async () => {
    const { alerter, bot, clock, history } = await setup();

    expect(alerter.onRunFinished(failedRow(clock), NO_RESULT)).toBe('failed');
    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(1);
    expect(bot.requests).toHaveLength(0);

    expect(await alerter.flush(SIGNAL)).toEqual({ sent: 1,
      failed: 0 });
    expect(messages(bot)).toHaveLength(1);
    expect(messages(bot)[0]).toContain('<b>FAILED</b> send-and-receive-event\ninstance test | outage');
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

  it('the error kept with a failed delivery is masked', async () => {
    const secret = 'hunter2-password';
    const database = await tempDatabase();

    cleanups.push(async () => database.remove());

    const { alerter, clock } = await setup({ database: database.path,
      redact: createRedactor([secret]),
      answer: { status: 404,
        body: `no chat for ${secret}` } });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);

    const raw = new DatabaseSync(database.path, { readOnly: true });
    const stored = String(raw.prepare('SELECT last_error FROM alert_outbox').get()?.last_error);

    raw.close();
    expect(stored).toContain('no chat for ***');
    expect(stored).not.toContain(secret);
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
   * Makes `saveAlert` and the probe of the alert tables throw while a switch is on; `kv` stays writable.
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
      },
      probeAlertStorage: (at): void => {
        if (state.broken) {
          throw new Error('disk full');
        }

        history.probeAlertStorage(at);
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

  it('an unchanged state from memory keeps the storage failing flag', async () => {
    const control = { broken: true };
    const { alerter, bot, clock } = await setup({ wrap: breakable(control) });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });
    expect(alerter.health().storageFailing).toBe(true);

    // A skipped run leaves the state as it is and writes nothing, so it proves nothing about the storage.
    expect(alerter.onRunFinished(failedRow(clock, { status: 'skipped',
      runId: 'rdddddddddddddddd' }), NO_RESULT)).toBeUndefined();
    expect(alerter.health().storageFailing).toBe(true);

    alerter.onRunFinished(failedRow(clock, { errorClass: 'collector_unavailable',
      failedStage: 'collector_availability',
      runId: 'rcccccccccccccccc' }), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(3);
    });
    expect(messages(bot)[2]).toContain('STILL FAILING');
    expect(messages(bot).filter(text => text.includes('STORAGE FAILING'))).toHaveLength(1);
  });

  it('a fault in the alert tables only keeps the failing flag on through health, whatever kv does', async () => {
    const control = { broken: true };
    const { alerter, bot, clock } = await setup({ wrap: breakable(control) });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });

    const failures = alerter.failures();

    expect(alerter.health().storageFailing).toBe(true);
    expect(alerter.health().storageFailing).toBe(true);
    expect(alerter.failures()).toBe(failures);
  });

  it('a probe that works clears the flag, but a second STORAGE FAILING waits for a real save', async () => {
    const control = { broken: true };
    const { alerter, bot, clock } = await setup({ wrap: breakable(control) });
    const stillFailing = (runId: string): RunRow => failedRow(clock, { errorClass: 'collector_unavailable',
      failedStage: 'collector_availability',
      runId });
    const storageNotices = (): number => messages(bot).filter(text => text.includes('STORAGE FAILING')).length;

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(2);
    });

    control.broken = false;
    expect(alerter.health().storageFailing).toBe(false);

    // The write path is still unproven for the alerts themselves: the fault returns, and the episode goes on.
    control.broken = true;
    alerter.onRunFinished(stillFailing('rcccccccccccccccc'), NO_RESULT);
    await vi.waitFor(() => {
      expect(bot.requests).toHaveLength(3);
    });
    expect(messages(bot)[2]).toContain('STILL FAILING');
    expect(storageNotices()).toBe(1);

    // A real save ends the episode; the next fault announces itself again.
    control.broken = false;
    alerter.onRunFinished(stillFailing('rdddddddddddddddd'), NO_RESULT);
    await alerter.flush(SIGNAL);
    control.broken = true;
    alerter.onRunFinished(okRow(clock), NO_RESULT);
    await vi.waitFor(() => {
      expect(storageNotices()).toBe(2);
    });
  });

  it('health does not probe the alert tables while the storage is fine', async () => {
    let probes = 0;
    const { alerter } = await setup({ wrap: history => ({ ...history,
      probeAlertStorage: (at): void => {
        probes += 1;
        history.probeAlertStorage(at);
      } }) });

    expect(alerter.health().storageFailing).toBe(false);
    expect(probes).toBe(0);
  });

  it('health probes do not count as storage failures', async () => {
    const { alerter, logger } = await setup({ wrap: history => ({ ...history,
      oldestUnsentAlert: () => {
        throw new Error('disk gone');
      } }) });
    const before = alerter.failures();

    for (let probe = 0; probe < 5; probe += 1) {
      expect(alerter.health().storageFailing).toBe(true);
    }

    expect(alerter.failures()).toBe(before);
    expect(logger.lines.filter(line => line.msg === 'alert storage failed: health')).toHaveLength(5);
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
      },
      probeAlertStorage: () => {
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
      open: [],
      announced: true,
      reported: [],
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

describe('alerter: one alert for an outage of Hawk', () => {
  const PROBE = 'endpoints-probe';
  const SOURCEMAPS = 'sourcemaps';
  const ENVELOPE = 'sentry-envelope';
  const CHECK = 'check-notification';
  const AVAILABLE = { name: 'collector_availability',
    status: 'ok',
    durationMs: 1 } as const;

  /**
   * Builds a run that failed at an availability stage.
   * @param clock Clock that gives the start time.
   * @param scenario Scenario that ran.
   * @param errorClass Class of the failure.
   * @returns Failed run row.
   */
  function down(clock: FakeClock, scenario: ScenarioName, errorClass: RunRow['errorClass'] = 'collector_unavailable'): RunRow {
    return failedRow(clock, { scenario,
      runId: `r${scenario.replaceAll(/[^a-z]/gu, '').slice(0, 15)
.padEnd(15, 'x')}`,
      failedStage: 'collector_availability',
      errorClass,
      stages: [] });
  }

  /**
   * Builds an `ok` run of a scenario.
   * @param clock Clock that gives the start time.
   * @param scenario Scenario of the run.
   * @param overrides Other fields.
   * @returns Run row.
   */
  function up(clock: FakeClock, scenario: ScenarioName, overrides: Partial<RunRow> = {}): RunRow {
    return { ...down(clock, scenario),
      status: 'ok',
      stages: [AVAILABLE],
      ...overrides };
  }

  /**
   * Builds the stored state of a scenario that announced an outage.
   * @param clock Clock that gives the time of the state.
   * @param scenario Scenario whose failure the state holds.
   * @param overrides Other fields.
   * @returns Alert state.
   */
  function announcedDown(clock: FakeClock, scenario: ScenarioName, overrides: Partial<AlertStateRow> = {}): AlertStateRow {
    return { scenario,
      state: 'failing',
      failureStreak: 1,
      episodeStartedAt: clock.wallTime().toISOString(),
      episodeFailures: 1,
      degraded: [],
      open: [{ pair: 'collector_availability@*',
        count: 1 }],
      announced: true,
      reported: [],
      updatedAt: clock.wallTime().toISOString(),
      ...overrides };
  }

  it('an hourly scenario that fails first announces itself, then the frequent one announces again', async () => {
    const { alerter, clock } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });

    expect(alerter.onRunFinished(down(clock, SOURCEMAPS), NO_RESULT)).toBe('failed');
    expect(alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT)).toBe('failed');
  });

  it('five scenarios with mixed classes send one FAILED, from the frequent one that failed first', async () => {
    const { alerter, bot, clock } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });
    const kinds = [
      alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT),
      alerter.onRunFinished(down(clock, CHECK, 'network_error'), NO_RESULT),
      alerter.onRunFinished(down(clock, ENVELOPE, 'dns_error'), NO_RESULT),
      alerter.onRunFinished(down(clock, PROBE, 'network_error'), NO_RESULT),
      alerter.onRunFinished(down(clock, PROBE), NO_RESULT),
    ];

    await alerter.flush(SIGNAL);
    expect(kinds).toEqual(['failed', undefined, undefined, undefined, undefined]);
    expect(messages(bot)).toHaveLength(1);
  });

  it('a follower that recovers first says nothing, the leader that recovers says RECOVERED', async () => {
    const { alerter, bot, clock } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });

    alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT);
    alerter.onRunFinished(down(clock, PROBE), NO_RESULT);
    expect(alerter.onRunFinished(up(clock, PROBE), NO_RESULT)).toBeUndefined();
    expect(alerter.onRunFinished(up(clock, SCENARIO), NO_RESULT)).toBe('recovered');
    await alerter.flush(SIGNAL);
    expect(messages(bot)).toHaveLength(2);
  });

  it('a follower that recovers with a warning sends DEGRADED', async () => {
    const { alerter, clock } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });

    alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT);
    alerter.onRunFinished(down(clock, PROBE), NO_RESULT);
    expect(alerter.onRunFinished(up(clock, PROBE, { degraded: ['quota_usage'] }), NO_RESULT)).toBe('degraded');
  });

  it('a follower with a new cause outside the availability stages sends FAILED', async () => {
    const { alerter, clock } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });

    alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT);
    alerter.onRunFinished(down(clock, CHECK), NO_RESULT);
    expect(alerter.onRunFinished(failedRow(clock, { scenario: CHECK,
      stages: [AVAILABLE] }), NO_RESULT)).toBe('failed');
  });

  it('a leader that is not in the scenarios does not hold back a follower', async () => {
    const { alerter, clock, history } = await setup({ scenarios: [PROBE, CHECK],
      probeThreshold: 1 });

    history.saveAlert(announcedDown(clock, SCENARIO), undefined);
    expect(alerter.onRunFinished(down(clock, PROBE), NO_RESULT)).toBe('failed');
  });

  it('a leader that has been silent longer than its interval and watchdog does not hold back a follower', async () => {
    const { alerter, clock, history } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });

    history.saveAlert(announcedDown(clock, SCENARIO), undefined);
    await clock.advance(30 * 60_000);
    expect(alerter.onRunFinished(down(clock, PROBE), NO_RESULT)).toBe('failed');
  });

  it('a leader whose FAILED was dropped ends the suppression', async () => {
    const { alerter, clock, history } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1 });
    const old = new Date(clock.wallTime().getTime() - 25 * HOUR_MS).toISOString();

    history.saveAlert(announcedDown(clock, SCENARIO), { text: 'FAILED',
      at: old });
    await alerter.flush(SIGNAL);
    expect(history.alertState(SCENARIO)?.announced).toBe(false);
    expect(alerter.onRunFinished(down(clock, PROBE), NO_RESULT)).toBe('failed');
  });

  it('a failed read of the other states suppresses nothing', async () => {
    const { alerter, clock, history } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1,
      wrap: base => ({ ...base,
        alertStates: (): AlertStateRow[] => {
          throw new Error('unreadable');
        } }) });

    history.saveAlert(announcedDown(clock, SCENARIO), undefined);
    expect(alerter.onRunFinished(down(clock, PROBE), NO_RESULT)).toBe('failed');
  });

  it('a restart between the runs keeps the leader and the follower apart', async () => {
    const database = await tempDatabase();

    cleanups.push(async () => database.remove());

    const first = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1,
      database: database.path });

    first.alerter.onRunFinished(down(first.clock, SCENARIO), NO_RESULT);
    await first.alerter.stop();

    const second = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1,
      database: database.path });

    expect(second.alerter.onRunFinished(down(second.clock, PROBE), NO_RESULT)).toBeUndefined();
    expect(second.alerter.onRunFinished(up(second.clock, PROBE), NO_RESULT)).toBeUndefined();
    expect(second.alerter.onRunFinished(up(second.clock, SCENARIO), NO_RESULT)).toBe('recovered');
  });

  it('a state saved while the storage failed is written with the next successful save', async () => {
    const control = { broken: true };
    const { alerter, clock, history } = await setup({ scenarios: SCENARIO_NAMES,
      probeThreshold: 1,
      wrap: base => ({ ...base,
        saveAlert: (...args): void => {
          if (control.broken) {
            throw new Error('disk full');
          }

          base.saveAlert(...args);
        } }) });

    alerter.onRunFinished(down(clock, SCENARIO), NO_RESULT);
    expect(history.alertState(SCENARIO)).toBeUndefined();
    control.broken = false;
    alerter.onRunFinished(down(clock, PROBE), NO_RESULT);
    expect(history.alertState(SCENARIO)?.state).toBe('failing');
    expect(history.alertState(PROBE)?.state).toBe('failing');
  });
});

describe('alerter: a rejected head does not hold the queue for a day', () => {
  const OTHER = 'check-notification';
  const GIVEN_UP = 'alert dropped after rejections';

  /**
   * Queues FAILED of one scenario and FAILED of another, in that order.
   * @param alerter Alerter under test.
   * @param clock Clock that gives the start time.
   */
  function queueTwo(alerter: Alerter, clock: FakeClock): void {
    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    alerter.onRunFinished(failedRow(clock, { scenario: OTHER,
      runId: 'rcccccccccccccccc' }), NO_RESULT);
  }

  /**
   * Runs `count` flushes, each after the longest retry pause.
   * @param alerter Alerter under test.
   * @param clock Fake clock.
   * @param count Number of flushes.
   */
  async function flushTimes(alerter: Alerter, clock: FakeClock, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await alerter.flush(SIGNAL);
      await clock.advance(600_000);
    }
  }

  it('a bot that answers 429 three times and then accepts loses nothing and keeps the order', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ answer: { status: 429 } });

    queueTwo(alerter, clock);
    await flushTimes(alerter, clock, 3);
    bot.setAnswer({});
    await flushTimes(alerter, clock, 1);

    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toEqual([]);
    expect(messages(bot).filter((_text, index) => index >= 3)
      .map(text => /<b>([^<]+)<\/b> (\S+)/u.exec(text)?.[2])).toEqual([SCENARIO, OTHER]);
    expect(logger.lines.some(line => line.msg === GIVEN_UP)).toBe(false);
  });

  it('a bot that answers 401 forever drops nothing', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ answer: { status: 401 } });

    queueTwo(alerter, clock);
    await flushTimes(alerter, clock, 8);

    expect(history.oldestUnsentAlert()).toBeDefined();
    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(2);
    expect(bot.requests.length).toBeGreaterThanOrEqual(8);
    expect(logger.lines.some(line => line.msg === GIVEN_UP)).toBe(false);
  });

  it('a message the bot rejects three times is given up once another one gets through, and its scenario announces again', async () => {
    const { alerter, bot, clock, history, logger } = await setup({ answer: { answerFor: message => message.includes(SCENARIO) ? { body: 'FAIL' } : undefined } });

    queueTwo(alerter, clock);
    await flushTimes(alerter, clock, 2);
    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(2);
    await alerter.flush(SIGNAL);

    expect(history.pendingAlerts('2100-01-01T00:00:00.000Z', 10)).toEqual([]);
    expect(messages(bot).at(-1)).toContain(OTHER);
    expect(logger.lines.find(line => line.msg === GIVEN_UP)).toMatchObject({ level: 'error',
      scenario: SCENARIO,
      text: expect.stringContaining(SCENARIO) as string });
    expect(history.alertState(SCENARIO)?.announced).toBe(false);
    expect(alerter.health().rejectedInRow).toBe(0);
  });

  it('a bot that rejects everything drops nothing, grows rejectedInRow and stops the heartbeat', async () => {
    const { alerter, clock, history, logger } = await setup({ answer: { body: 'FAIL' } });

    queueTwo(alerter, clock);
    await flushTimes(alerter, clock, 6);

    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(2);
    expect(alerter.health().rejectedInRow).toBeGreaterThanOrEqual(6);
    expect(logger.lines.some(line => line.msg === GIVEN_UP)).toBe(false);
    expect(heartbeatReason({ scheduler: { scheduler: true,
      storage: true,
      stuck: [] },
    alerts: alerter.health(),
    scenarios: [],
    lastVerdictAt: () => undefined,
    freshnessMs: () => 1,
    nowWallMs: 0,
    startedWallMs: 0 })).toEqual({ reason: 'alerts are not delivered' });
  });

  it('a bot that cannot be reached holds the queue', async () => {
    const { alerter, bot, clock, history, logger } = await setup();

    queueTwo(alerter, clock);
    await bot.close();
    await flushTimes(alerter, clock, 6);

    expect(history.pendingAlerts(clock.wallTime().toISOString(), 10)).toHaveLength(2);
    expect(logger.lines.some(line => line.msg === GIVEN_UP)).toBe(false);
  });

  it('a delivered message whose mark failed is not sent again', async () => {
    let failures = 1;
    const { alerter, bot, clock, history } = await setup({ wrap: base => ({ ...base,
      alertAttempt: (id, update): void => {
        if (update.sentAt !== undefined && failures > 0) {
          failures -= 1;
          throw new Error('disk full');
        }

        base.alertAttempt(id, update);
      } }) });

    alerter.onRunFinished(failedRow(clock), NO_RESULT);
    await alerter.flush(SIGNAL);
    expect(bot.requests).toHaveLength(1);
    expect(history.oldestUnsentAlert()).toBeDefined();

    await alerter.flush(SIGNAL);
    expect(bot.requests).toHaveLength(1);
    expect(history.oldestUnsentAlert()).toBeUndefined();
  });
});

describe('alerter: the length of an episode', () => {
  it('RECOVERED counts the downtime from the first failed run of the series', async () => {
    const { alerter, bot, clock } = await setup({ probeThreshold: 3 });
    const probe = (status: RunRow['status'], sequence: number): RunRow => failedRow(clock, { scenario: 'endpoints-probe',
      status,
      sequence,
      failedStage: 'garage_availability',
      errorClass: 'garage_unavailable',
      stages: status === 'ok'
        ? [{ name: 'garage_availability',
            status: 'ok',
            durationMs: 1 }]
        : [],
      runId: `r${String.fromCodePoint(96 + sequence).repeat(16)}` });

    for (const [index, status] of (['failed', 'failed', 'failed'] as const).entries()) {
      alerter.onRunFinished(probe(status, index + 1), NO_RESULT);
      await clock.advance(90_000);
    }

    expect(alerter.onRunFinished(probe('ok', 4), NO_RESULT)).toBe('recovered');
    await alerter.flush(SIGNAL);
    expect(messages(bot).at(-1)).toContain('down 4m 30s');
  });
});
