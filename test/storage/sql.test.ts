import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSql } from '../../src/storage/sql.js';

describe('transaction', () => {
  it('keeps the error of a body whose transaction was already rolled back', () => {
    const db = new DatabaseSync(':memory:');
    const sql = createSql(db);

    expect(() => sql.transaction(() => {
      db.exec('ROLLBACK');

      throw new Error('disk full');
    })).toThrow('disk full');
    expect(db.isTransaction).toBe(false);
  });

  it('rolls back a body that throws', () => {
    const db = new DatabaseSync(':memory:');
    const sql = createSql(db);

    db.exec('CREATE TABLE t (id INTEGER)');
    expect(() => sql.transaction(() => {
      sql.run('INSERT INTO t (id) VALUES (1)');

      throw new Error('body failed');
    })).toThrow('body failed');
    expect(sql.all('SELECT id FROM t')).toEqual([]);
    expect(db.isTransaction).toBe(false);
  });
});
