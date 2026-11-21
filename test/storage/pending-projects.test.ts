import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { NEW_PROJECT_PENDING_KEY } from '../../src/storage/keys.js';
import { pendingProjects } from '../../src/storage/pending-projects.js';

const FIRST = 'raaaaaaaaaaaaaaa';
const SECOND = 'rbbbbbbbbbbbbbbb';
const AT = '2026-11-15T10:00:00.000Z';

/** A record over an in-memory history. */
interface Opened {
  /** History under the record. */
  history: ReturnType<typeof createHistory>;
  /** The record. */
  pending: ReturnType<typeof pendingProjects>;
}

/**
 * Builds a record over an in-memory history.
 * @returns The record and the history under it.
 */
function open(): Opened {
  const history = createHistory(openDatabase(':memory:'));

  return { history,
    pending: pendingProjects(history) };
}

describe('pendingProjects', () => {
  it('starts empty', () => {
    expect(open().pending.list()).toEqual([]);
  });

  it('keeps the runs in the order they were added, each once, as a JSON list', () => {
    const { pending, history } = open();

    pending.add(FIRST, AT);
    pending.add(SECOND, AT);
    pending.add(FIRST, '2026-11-15T11:00:00.000Z');

    expect(pending.list()).toEqual([{ runId: FIRST,
      at: AT }, { runId: SECOND,
      at: AT }]);
    expect(JSON.parse(history.getKv(NEW_PROJECT_PENDING_KEY) ?? 'null')).toEqual(pending.list());
  });

  it('drops a run and removes the key when none is left', () => {
    const { pending, history } = open();

    pending.add(FIRST, AT);
    pending.drop(SECOND);
    expect(pending.list()).toHaveLength(1);
    pending.drop(FIRST);
    expect(pending.list()).toEqual([]);
    expect(history.getKv(NEW_PROJECT_PENDING_KEY)).toBeUndefined();
  });

  it.each([
    ['not JSON', '{'],
    ['not a list', '{"runId":"x"}'],
  ])('reads a value that is %s as empty', (_label, value) => {
    const { pending, history } = open();

    history.setKv(NEW_PROJECT_PENDING_KEY, value);
    expect(pending.list()).toEqual([]);
  });

  it('skips entries that are malformed', () => {
    const { pending, history } = open();

    history.setKv(NEW_PROJECT_PENDING_KEY, JSON.stringify([{ runId: FIRST,
      at: AT }, { runId: 'short',
      at: AT }, { runId: SECOND,
      at: 'yesterday' }, { runId: 'aaaaaaaaaaaaaaaa',
      at: AT }, 7]));
    expect(pending.list()).toEqual([{ runId: FIRST,
      at: AT }]);
  });
});
