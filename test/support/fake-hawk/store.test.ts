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

describe('fake store subscribe', () => {
  it('tells isNew on the first event and false on a repetition', () => {
    const store = createFakeStore();
    const seen: Array<[string, string, boolean, number]> = [];

    store.subscribe((projectId, event, isNew) => {
      seen.push([projectId, event.id, isNew, event.totalCount]);
    });

    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(seen).toEqual([[PROJECT, first.id, true, 1], [PROJECT, first.id, false, 2]]);
  });

  it('a removed event is new again when it comes back', () => {
    const store = createFakeStore();
    const flags: boolean[] = [];

    store.subscribe((_projectId, _event, isNew) => {
      flags.push(isNew);
    });

    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    store.remove(PROJECT, first.id);
    store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(flags).toEqual([true, true]);
  });

  it('the unsubscribe function stops the calls and others keep going', () => {
    const store = createFakeStore();
    const calls = { a: 0,
      b: 0 };
    const stopA = store.subscribe(() => {
      calls.a += 1;
    });

    store.subscribe(() => {
      calls.b += 1;
    });
    store.ingest(PROJECT, 'errors/nodejs', { title: 'one' });
    stopA();
    store.ingest(PROJECT, 'errors/nodejs', { title: 'two' });

    expect(calls).toEqual({ a: 1,
      b: 2 });
  });

  it('a throwing listener does not break ingest or the other listeners', () => {
    const store = createFakeStore();
    let reached = false;

    store.subscribe(() => {
      throw new Error('listener failed');
    });
    store.subscribe(() => {
      reached = true;
    });

    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(store.get(PROJECT, event.id)).toBe(event);
    expect(reached).toBe(true);
  });

  it('the listener already sees the event in the store', () => {
    const store = createFakeStore();
    let found = false;

    store.subscribe((projectId, event) => {
      found = store.get(projectId, event.id) === event;
    });
    store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(found).toBe(true);
  });

  it('stamps an event with the time of its arrival in Unix seconds, and a test may change it', () => {
    const before = Math.floor(Date.now() / 1000);
    const store = createFakeStore();
    const event = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    expect(event.timestamp).toBeGreaterThanOrEqual(before);
    expect(event.timestamp).toBeLessThanOrEqual(before + 5);
    expect(store.setTimestamp(PROJECT, event.id, 1000)).toBe(true);
    expect(store.get(PROJECT, event.id)?.timestamp).toBe(1000);
    expect(store.setTimestamp(PROJECT, 'missing', 1000)).toBe(false);
  });

  it('a repetition keeps the time of the first arrival', () => {
    const store = createFakeStore();
    const first = store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' });

    store.setTimestamp(PROJECT, first.id, 1000);
    expect(store.ingest(PROJECT, 'errors/nodejs', { title: 'boom' }).timestamp).toBe(1000);
  });
});
