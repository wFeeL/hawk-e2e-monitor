import type { HistoryCommand } from '../cli.js';
import type { HistoryConfig } from '../config/load.js';
import { HIDDEN_SCENARIOS } from '../scenarios/names.js';
import { EmptyDatabaseError, openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import type { RunRow, ScenarioStats } from '../storage/types.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import type { CheckIo } from './check.js';

/** Replacements for the default dependencies, for tests. */
export interface HistoryDeps {
  /** Time source for the statistics windows. */
  clock: Pick<Clock, 'wallTime'>;
}

const RUNS_HEADER = ['STARTED', 'SCENARIO', 'STATUS', 'DURATION', 'STAGE', 'CLASS'];
const STATS_HEADER = ['SCENARIO', '24H ok/failed', '7D ok/failed', 'LAST'];
const COLUMN_GAP = '  ';

/**
 * Writes JSON in which every duration (a key ending in `Ms`) is a whole number of milliseconds.
 * @param value Row or statistics to print.
 * @returns JSON text on one line.
 */
function toJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => key.endsWith('Ms') && typeof item === 'number' ? Math.round(item) : item);
}

/**
 * Lays out rows in columns as wide as their longest cell.
 * @param header Column titles.
 * @param rows Cells of each row.
 * @returns Text with one line per row, the header first, ending with a newline.
 */
function table(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const all = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...all.map(row => (row[column] ?? '').length)));

  return all.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))
    .join(COLUMN_GAP)).join('\n') + '\n';
}

/**
 * Builds the cells of one run.
 * @param row Stored run.
 * @returns Cells in the order of `RUNS_HEADER`; `-` marks a value the run does not have.
 */
function runCells(row: RunRow): string[] {
  return [row.startedAt, row.scenario, row.status, row.durationMs === undefined ? '-' : `${String(Math.round(row.durationMs))} ms`,
    row.failedStage ?? '-', row.errorClass ?? '-'];
}

/**
 * Builds the cells of the statistics of one scenario.
 * @param item Statistics of the scenario.
 * @returns Cells in the order of `STATS_HEADER`.
 */
function statsCells(item: ScenarioStats): string[] {
  return [item.scenario, `${String(item.last24h.ok)}/${String(item.last24h.failed)}`, `${String(item.last7d.ok)}/${String(item.last7d.failed)}`,
    item.lastRun === undefined ? '-' : `${item.lastRun.status} ${item.lastRun.startedAt}`];
}

/**
 * Prints stored runs or statistics. The database is opened read-only, so it is safe next to a running `serve`.
 * @param command Parsed `history` command.
 * @param config Database path and scenarios.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @returns Exit code: 0 on success, 1 when there is no history or it cannot be read.
 */
export function runHistoryCommand(command: HistoryCommand, config: HistoryConfig, io: CheckIo, deps: Partial<HistoryDeps> = {}): number {
  const { databasePath } = config;
  let history;

  try {
    history = createHistory(openDatabase(databasePath, { readOnly: true }));
  } catch (error) {
    const missing = error instanceof EmptyDatabaseError || (error instanceof Error && error.message.startsWith('No database file'));

    io.stderr(missing ? `No history at ${databasePath}\n` : `Cannot read ${databasePath}: ${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  }

  try {
    if (command.stats) {
      const scenarios = command.scenario === undefined ? config.scenarios : [command.scenario];

      const stats = history.stats((deps.clock ?? systemClock).wallTime(), scenarios);

      io.stdout(command.json ? `${toJson(stats)}\n` : table(STATS_HEADER, stats.map(statsCells)));
    } else {
      const rows = history.list({ ...command.scenario === undefined ? { exceptScenarios: HIDDEN_SCENARIOS } : { scenario: command.scenario },
        limit: command.limit });

      io.stdout(command.json ? rows.map(row => `${toJson(row)}\n`).join('') : table(RUNS_HEADER, rows.map(runCells)));
    }

    return 0;
  } catch (error) {
    io.stderr(`Cannot read ${databasePath}: ${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  } finally {
    history.close();
  }
}
