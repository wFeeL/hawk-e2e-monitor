import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { SqlRow } from './rows.js';

/** The ways the stores talk to one database. */
export interface Sql {
  /**
   * Runs the work in one immediate transaction.
   * @param work Body to run; its throw rolls the transaction back.
   * @returns What the body returned.
   */
  transaction: <T>(work: () => T) => T;
  /**
   * Reads every row of a query.
   * @param query SQL text.
   * @param params Values of the placeholders.
   * @returns All rows.
   */
  all: (query: string, ...params: SQLInputValue[]) => SqlRow[];
  /**
   * Reads the first row of a query.
   * @param query SQL text.
   * @param params Values of the placeholders.
   * @returns The row, or undefined when there is none.
   */
  one: (query: string, ...params: SQLInputValue[]) => SqlRow | undefined;
  /**
   * Runs a statement that writes.
   * @param query SQL text.
   * @param params Values of the placeholders.
   * @returns Number of rows changed.
   */
  run: (query: string, ...params: SQLInputValue[]) => number;
  /**
   * Reads the rows of a query one by one.
   * @param query SQL text.
   * @param params Values of the placeholders.
   * @returns Iterator over the rows, so a caller can stop early.
   */
  iterate: (query: string, ...params: SQLInputValue[]) => NodeJS.Iterator<Record<string, SQLOutputValue>>;
}

/**
 * Wraps a database in the helpers every store uses.
 * @param db Open database.
 * @returns The helpers bound to it.
 */
export function createSql(db: DatabaseSync): Sql {
  const transaction = <T>(body: () => T): T => {
    db.exec('BEGIN IMMEDIATE');

    try {
      const value = body();

      db.exec('COMMIT');

      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const all = (query: string, ...params: SQLInputValue[]): SqlRow[] => db.prepare(query).all(...params);
  const one = (query: string, ...params: SQLInputValue[]): SqlRow | undefined => db.prepare(query).get(...params);
  const run = (query: string, ...params: SQLInputValue[]): number => Number(db.prepare(query).run(...params).changes);
  const iterate = (query: string, ...params: SQLInputValue[]): NodeJS.Iterator<Record<string, SQLOutputValue>> => db.prepare(query).iterate(...params);

  return { transaction,
    all,
    one,
    run,
    iterate };
}
