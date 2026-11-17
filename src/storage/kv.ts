import { text } from './rows.js';
import type { Sql } from './sql.js';

/** Small values kept by key. */
export interface KvStore {
  /**
   * Reads a stored value.
   * @param key Key the value is kept under.
   * @returns The value, or undefined.
   */
  getKv(key: string): string | undefined;
  /**
   * Stores a value.
   * @param key Key to keep the value under.
   * @param value Text to keep under the key.
   */
  setKv(key: string, value: string): void;
  /**
   * Reads a key and writes the value `decide` returns, in one immediate transaction.
   * @param key Key in `kv`.
   * @param decide Gets the current value; returns the value to write, `null` to delete the key, or undefined to leave it.
   * @returns The value before the call.
   */
  updateKv(key: string, decide: (current: string | undefined) => string | null | undefined): string | undefined;
  /**
   * Removes a stored value.
   * @param key Key the value is kept under.
   */
  deleteKv(key: string): void;
}

/**
 * Creates the key-value store over a database.
 * @param sql Helpers bound to the database.
 * @returns Store bound to it.
 */
export function createKvStore(sql: Sql): KvStore {
  const { transaction, one, run } = sql;

  const getKv: KvStore['getKv'] = (key) => {
    return text(one('SELECT value FROM kv WHERE key = ?', key) ?? {}, 'value');
  };

  const setKv: KvStore['setKv'] = (key, value) => {
    run('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', key, value);
  };

  const deleteKv: KvStore['deleteKv'] = (key) => {
    run('DELETE FROM kv WHERE key = ?', key);
  };

  const updateKv: KvStore['updateKv'] = (key, decide) => {
    return transaction(() => {
      const current = getKv(key);
      const next = decide(current);

      if (next === null) {
        deleteKv(key);
      } else if (next !== undefined) {
        setKv(key, next);
      }

      return current;
    });
  };

  return {
    getKv,
    setKv,
    updateKv,
    deleteKv,
  };
}
