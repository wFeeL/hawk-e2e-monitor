import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryCommand } from '../../src/cli.js';
import type { HistoryConfig } from '../../src/config/load.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import type { History } from '../../src/storage/history.js';
import type { ScenarioStats } from '../../src/storage/types.js';
import { seedLease, tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { runResultFixture } from '../support/run-result.js';
import type { CheckIo } from '../../src/commands/check.js';
import { runHistoryCommand } from '../../src/commands/history.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const LIST: HistoryCommand = { kind: 'history',
  limit: 20,
  stats: false,
  json: true };
const TABLE: HistoryCommand = { ...LIST,
  json: false };

let database: TempDatabase;
let config: HistoryConfig;

beforeEach(async () => {
  database = await tempDatabase();
  config = { databasePath: database.path,
    scenarios: ['send-and-receive-event', 'check-notification'] };
});

afterEach(async () => {
  await database.remove();
});

/** The parts of a printed row the tests read. */
interface RowShape {
  /** Id of the run. */
  runId: string;
  /** Stages of the run. */
  stages: unknown[];
  /** Duration of the run. */
  durationMs: number;
}

/** What a run wrote. */
interface Captured {
  /** Exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Runs the command and captures its output.
 * @param command Parsed command.
 * @returns Exit code and both streams.
 */
function run(command: HistoryCommand = LIST): Captured {
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

  captured.code = runHistoryCommand(command, config, io, { clock: { wallTime: () => NOW } });

  return captured;
}

/**
 * Writes finished runs into the database file.
 * @param fill Receives the history to write to.
 */
function seed(fill: (history: History) => void): void {
  const history = createHistory(openDatabase(database.path));

  fill(history);
  history.close();
}

/**
 * Stores one `ok` run.
 * @param history History to write to.
 * @param runId Id given to the run.
 * @param scenario Scenario of the run.
 * @param hoursAgo Age of the start.
 */
function store(history: History, runId: string, scenario: 'check-notification' | 'endpoints-probe' | 'send-and-receive-event', hoursAgo: number): void {
  const startedAt = new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

  history.startRun({ runId,
    scenario,
    sequence: 1,
    trigger: 'schedule',
    startedAt });
  history.finishRun(runId, { status: 'ok',
    finishedAt: startedAt,
    durationMs: 10,
    degraded: [],
    result: runResultFixture({ runId,
      scenario,
      eventLatencyMs: 500 }) });
}

describe('runHistoryCommand tables', () => {
  /**
   * Stores one failed run with a fractional duration.
   * @param history History to write to.
   */
  function storeFailed(history: History): void {
    history.startRun({ runId: 'rfffffffffffffffff',
      scenario: 'check-notification',
      sequence: 2,
      trigger: 'schedule',
      startedAt: '2026-03-10T10:00:00.000Z' });
    history.finishRun('rfffffffffffffffff', { status: 'failed',
      finishedAt: '2026-03-10T10:00:01.000Z',
      durationMs: 705.9054660000002,
      degraded: [],
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      result: runResultFixture({ runId: 'rfffffffffffffffff',
        scenario: 'check-notification',
        status: 'failed',
        failedStage: 'event_visible',
        errorClass: 'event_not_found' }) });
  }

  it('prints a table by default, newest first, with rounded milliseconds', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 3);
      storeFailed(history);
    });

    const { code, stdout } = run(TABLE);
    const lines = stdout.trimEnd().split('\n');

    expect(code).toBe(0);
    expect(lines[0]).toMatch(/^STARTED +SCENARIO +STATUS +DURATION +STAGE +CLASS$/u);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^2026-03-10T10:00:00\.000Z +check-notification +failed +706 ms +event_visible +event_not_found$/u);
    expect(lines[2]).toMatch(/^2026-03-10T09:00:00\.000Z +send-and-receive-event +ok +10 ms +- +-$/u);
  });

  it('keeps the JSON lines with --json and rounds the milliseconds there too', () => {
    seed((history) => {
      storeFailed(history);
    });

    const row = JSON.parse(run(LIST).stdout.trimEnd()) as RowShape;

    expect(row.durationMs).toBe(706);
  });

  it('prints the statistics as a table, and as an array with --json', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 1);
      storeFailed(history);
    });

    const lines = run({ ...TABLE,
      stats: true }).stdout.trimEnd()
      .split('\n');

    expect(lines[0]).toMatch(/^SCENARIO +24H ok\/failed +7D ok\/failed +LAST$/u);
    expect(lines[1]).toMatch(/^send-and-receive-event +1\/0 +1\/0 +ok 2026-03-10T11:00:00\.000Z$/u);
    expect(lines[2]).toMatch(/^check-notification +0\/1 +0\/1 +failed 2026-03-10T10:00:00\.000Z$/u);
    expect(JSON.parse(run({ ...LIST,
      stats: true }).stdout) as unknown[]).toHaveLength(2);
  });
});

describe('runHistoryCommand', () => {
  it('prints one JSON row per line, newest first, with the stages', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 3);
      store(history, 'rbbbbbbbbbbbbbbbb', 'check-notification', 2);
      store(history, 'rcccccccccccccccc', 'send-and-receive-event', 1);
    });

    const { code, stdout } = run();
    const rows = stdout.trimEnd().split('\n')
      .map(line => JSON.parse(line) as RowShape);

    expect(code).toBe(0);
    expect(rows.map(row => row.runId)).toEqual(['rcccccccccccccccc', 'rbbbbbbbbbbbbbbbb', 'raaaaaaaaaaaaaaaa']);
    expect(rows[0]?.stages).toHaveLength(5);
  });

  it('filters by scenario and honours the limit', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 3);
      store(history, 'rbbbbbbbbbbbbbbbb', 'check-notification', 2);
      store(history, 'rcccccccccccccccc', 'send-and-receive-event', 1);
    });

    const filtered = run({ ...LIST,
      scenario: 'send-and-receive-event' });

    expect(filtered.stdout.trimEnd().split('\n')).toHaveLength(2);
    expect((run({ ...LIST,
      limit: 1 })).stdout.trimEnd().split('\n')).toHaveLength(1);
  });

  it('leaves the probe out of the list unless it is named', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 3);
      store(history, 'rbbbbbbbbbbbbbbbb', 'endpoints-probe', 2);
      store(history, 'rcccccccccccccccc', 'endpoints-probe', 1);
    });

    const ids = (command: HistoryCommand): string[] => run(command).stdout.trimEnd()
      .split('\n')
      .map(line => (JSON.parse(line) as RowShape).runId);

    expect(ids(LIST)).toEqual(['raaaaaaaaaaaaaaaa']);
    expect(ids({ ...LIST,
      limit: 1 })).toEqual(['raaaaaaaaaaaaaaaa']);
    expect(ids({ ...LIST,
      scenario: 'endpoints-probe' })).toEqual(['rcccccccccccccccc', 'rbbbbbbbbbbbbbbbb']);
  });

  it('--stats prints one JSON array with a window per configured scenario', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 1);
    });

    const { code, stdout } = run({ ...LIST,
      stats: true });
    const stats = JSON.parse(stdout) as ScenarioStats[];

    expect(code).toBe(0);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(stats.map(item => item.scenario)).toEqual(['send-and-receive-event', 'check-notification']);
    expect(stats[0]?.last24h).toMatchObject({ ok: 1,
      eventLatencyP50Ms: 500 });
    expect(stats[1]?.last24h.ok).toBe(0);
  });

  it('--stats with --scenario reports that scenario only', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 1);
    });

    const { stdout } = run({ ...LIST,
      stats: true,
      scenario: 'check-notification' });

    expect((JSON.parse(stdout) as ScenarioStats[]).map(item => item.scenario)).toEqual(['check-notification']);
  });

  it('prints No history and exits 1 when the file is missing, and does not create it', () => {
    const { code, stdout, stderr } = run();

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe(`No history at ${database.path}\n`);
    expect(existsSync(database.path)).toBe(false);
  });

  it('prints No history for a file without a schema', () => {
    new DatabaseSync(database.path).close();

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toBe(`No history at ${database.path}\n`);
  });

  it('reads while serve holds the lease and changes no row', () => {
    seed((history) => {
      store(history, 'raaaaaaaaaaaaaaaa', 'send-and-receive-event', 1);
    });
    seedLease(database.path, { pid: 1,
      hostname: 'box',
      at: NOW.toISOString() });

    const before = (run()).stdout;
    const { code, stdout } = run({ ...LIST,
      stats: true });

    expect(code).toBe(0);
    expect(stdout).not.toBe('');
    expect((run()).stdout).toBe(before);
  });
});
