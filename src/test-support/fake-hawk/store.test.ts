import { describe, expect, it } from 'vitest';
import { createFakeStore, objectIdLike } from './store.js';

const PROJECT = 'a'.repeat(24);

describe('fake store', () => {
  it('new title creates event', () => {
    const store = createFakeStore();
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom',
      context: { runId: 'r1' } });

    expect(event.totalCount).toBe(1);
    expect(event.id).toMatch(/^[0-9a-f]{24}$/u);
    expect(event.groupHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(event.repetitionIds).toEqual([]);
    expect(event.lastRepetitionId).toBeUndefined();
    expect(store.all(PROJECT)).toHaveLength(1);
    expect(store.get(PROJECT, event.id)).toBe(event);
  });

  it('same title and catcherType repeats', () => {
    const store = createFakeStore();
    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });
    const originalId = first.id;
    const second = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(second).toBe(first);
    expect(second.id).toBe(originalId);
    expect(second.totalCount).toBe(2);
    expect(second.repetitionIds).toHaveLength(1);
    expect(second.lastRepetitionId).toBe(second.repetitionIds[0]);
    expect(second.lastRepetitionId).not.toBe(originalId);
    expect(store.all(PROJECT)).toHaveLength(1);
  });

  it('different catcherType is a new event', () => {
    const store = createFakeStore();
    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });
    const second = store.ingest(PROJECT, 'errors/javascript', { title: 'boom' });

    expect(second.id).not.toBe(first.id);
    expect(second.groupHash).not.toBe(first.groupHash);
    expect(store.all(PROJECT)).toHaveLength(2);
  });

  it('search finds by title and by context, case-insensitive', () => {
    const store = createFakeStore();
    const byTitle = store.ingest(PROJECT, 'errors/nodejs', { title: 'Hello World' });
    const byContext = store.ingest(PROJECT, 'errors/nodejs', { title: 'other',
      context: { runId: 'AbCdEf' } });

    store.ingest(PROJECT, 'errors/nodejs', { title: 'unrelated' });

    expect(store.search(PROJECT, 'hello wORLD')).toEqual([byTitle]);
    expect(store.search(PROJECT, 'abcdef')).toEqual([byContext]);
    expect(store.search('b'.repeat(24), 'hello')).toEqual([]);
  });

  it('search truncates to 50 chars', () => {
    const store = createFakeStore();
    const head = 'x'.repeat(50);
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: `${head}${'y'.repeat(10)}` });

    expect(store.search(PROJECT, `${head}${'y'.repeat(10)}`)).toEqual([event]);
    expect(store.search(PROJECT, `${head}zzzzzzzzzz`)).toEqual([event]);
  });

  it('remove deletes and returns true, second remove false', () => {
    const store = createFakeStore();
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });
    const repetitionId = event.repetitionIds[0] ?? '';

    expect(store.remove(PROJECT, repetitionId)).toBe(false);
    expect(store.remove(PROJECT, event.id)).toBe(true);
    expect(store.remove(PROJECT, event.id)).toBe(false);
    expect(store.get(PROJECT, event.id)).toBeUndefined();
    expect(store.all(PROJECT)).toEqual([]);
  });

  it('uses the injected id generator and a missing title hashes as "undefined"', () => {
    let n = 0;
    const store = createFakeStore(() => String(++n).padStart(24, '0'));
    const first = store.ingest(PROJECT, 'errors/nodejs', {});
    const second = store.ingest(PROJECT, 'errors/nodejs', { title: 42 });

    expect(first.id).toBe('000000000000000000000001');
    expect(second).toBe(first);
    expect(second.lastRepetitionId).toBe('000000000000000000000002');
    expect(objectIdLike()).toMatch(/^[0-9a-f]{24}$/u);
  });
});
