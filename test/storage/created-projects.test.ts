import { describe, expect, it } from 'vitest';
import { createdProjects } from '../../src/storage/created-projects.js';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { NEW_PROJECT_KEY } from '../../src/storage/keys.js';

/** A record over an in-memory history. */
interface Opened {
  /** History under the record. */
  history: ReturnType<typeof createHistory>;
  /** The record. */
  record: ReturnType<typeof createdProjects>;
}

/**
 * Builds a record over an in-memory history.
 * @returns The record and the history under it.
 */
function open(): Opened {
  const history = createHistory(openDatabase(':memory:'));

  return { history,
    record: createdProjects(history) };
}

describe('createdProjects', () => {
  it('starts empty', () => {
    expect(open().record.ids()).toEqual([]);
  });

  it('keeps the ids in the order they were recorded, each once', () => {
    const { record, history } = open();

    record.record('a'.repeat(24));
    record.record('b'.repeat(24));
    record.record('a'.repeat(24));

    expect(record.ids()).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
    expect(JSON.parse(history.getKv(NEW_PROJECT_KEY) ?? 'null')).toEqual(['a'.repeat(24), 'b'.repeat(24)]);
  });

  it('forgets an id and drops the key when none is left', () => {
    const { record, history } = open();

    record.record('a'.repeat(24));
    record.record('b'.repeat(24));
    record.forget('a'.repeat(24));
    expect(record.ids()).toEqual(['b'.repeat(24)]);
    record.forget('b'.repeat(24));
    expect(history.getKv(NEW_PROJECT_KEY)).toBeUndefined();
    record.forget('c'.repeat(24));
    expect(record.ids()).toEqual([]);
  });

  it('reads a damaged value as empty and writes a clean one next time', () => {
    const { record, history } = open();

    history.setKv(NEW_PROJECT_KEY, '{not json');
    expect(record.ids()).toEqual([]);
    record.record('a'.repeat(24));
    expect(record.ids()).toEqual(['a'.repeat(24)]);
  });

  it('ignores entries that are not ids', () => {
    const { record, history } = open();

    history.setKv(NEW_PROJECT_KEY, JSON.stringify(['a'.repeat(24), 7, 'short']));
    expect(record.ids()).toEqual(['a'.repeat(24)]);
  });
});
