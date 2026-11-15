import type { HistoryCommand } from '../cli.js';
import type { Config } from '../config/load.js';
import { HIDDEN_SCENARIOS } from '../scenarios/names.js';
import { EmptyDatabaseError, openDatabase } from '../storage/database.js';
import { createHistory } from '../storage/history.js';
import { systemClock } from '../time/clock.js';
import type { Clock } from '../time/clock.js';
import type { CheckIo } from './check.js';

/** Replacements for the default dependencies, for tests. */
export interface HistoryDeps {
  /** Time source for the statistics windows. */
  clock: Pick<Clock, 'wallTime'>;
}

/**
 * Prints stored runs or statistics. The database is opened read-only, so it is safe next to a running `serve`.
 * @param command Parsed `history` command.
 * @param config Validated configuration.
 * @param io Output streams.
 * @param deps Replacements for the default dependencies, for tests.
 * @returns Exit code: 0 on success, 1 when there is no history or it cannot be read.
 */
export function runHistoryCommand(command: HistoryCommand, config: Config, io: CheckIo, deps: Partial<HistoryDeps> = {}): number {
  const { databasePath } = config.monitoring;
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
      const scenarios = command.scenario === undefined ? config.monitoring.scenarios : [command.scenario];

      io.stdout(`${JSON.stringify(history.stats((deps.clock ?? systemClock).wallTime(), scenarios))}\n`);
    } else {
      for (const row of history.list({ ...command.scenario === undefined ? { exceptScenarios: HIDDEN_SCENARIOS } : { scenario: command.scenario },
        limit: command.limit })) {
        io.stdout(`${JSON.stringify(row)}\n`);
      }
    }

    return 0;
  } catch (error) {
    io.stderr(`Cannot read ${databasePath}: ${error instanceof Error ? error.message : String(error)}\n`);

    return 1;
  } finally {
    history.close();
  }
}
