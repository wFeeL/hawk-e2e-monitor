import { createHash, randomBytes } from 'node:crypto';

const SEARCH_LIMIT = 50;

/** Event as the fake grouper keeps it. */
export interface StoredEvent {
  /** 24 hex characters, id of the original event. */
  id: string;
  /** Hash of catcherType and title. */
  groupHash: string;
  /** Number of occurrences, including the original. */
  totalCount: number;
  /** Catcher type the event arrived with. */
  catcherType: string;
  /** Payload as received, context as an object. */
  payload: Record<string, unknown>;
  /** Ids of repetitions in arrival order. */
  repetitionIds: string[];
  /** Id of the latest repetition, if any. */
  lastRepetitionId: string | undefined;
}

/** Called after an event was stored or repeated. */
export type StoreListener = (projectId: string, event: StoredEvent, isNew: boolean) => void;

/** In-memory events with the grouping behavior of the Hawk grouper worker. */
export interface FakeStore {
  /**
   * Stores an event or counts a repetition of an existing group.
   * @param projectId Project the event belongs to.
   * @param catcherType Catcher type of the message.
   * @param payload Event payload.
   * @returns The live original event (updated on repetition).
   */
  ingest(projectId: string, catcherType: string, payload: Record<string, unknown>): StoredEvent;
  /**
   * Finds events by a case-insensitive substring of title or context.
   * @param projectId Project to search in.
   * @param text Search text, cut to 50 characters.
   * @returns Matching events in insertion order.
   */
  search(projectId: string, text: string): StoredEvent[];
  /**
   * Looks an event up by the id of the original event.
   * @param projectId Project to look in.
   * @param eventId Original event id.
   * @returns The event or undefined.
   */
  get(projectId: string, eventId: string): StoredEvent | undefined;
  /**
   * Removes an event with all its repetitions.
   * @param projectId Project to remove from.
   * @param eventId Original event id.
   * @returns Whether an event was removed.
   */
  remove(projectId: string, eventId: string): boolean;
  /**
   * Lists all events of a project.
   * @param projectId Project to list.
   * @returns Events in insertion order.
   */
  all(projectId: string): StoredEvent[];
  /**
   * Listens to every `ingest`, the way the grouper hands events to the notifier.
   * A listener that throws is ignored, so it cannot break `ingest` or other listeners.
   * @param listener Gets the project, the live event and whether it started a new group.
   * @returns Function that removes the listener.
   */
  subscribe(listener: StoreListener): () => void;
}

/**
 * Generates an id shaped like a Mongo ObjectId.
 * @returns 24 hex characters.
 */
export function objectIdLike(): string {
  return randomBytes(12).toString('hex');
}

/**
 * Reads the title the way the grouper hashes it.
 * @param payload Event payload.
 * @returns Title, or the string "undefined" when it is not a string.
 */
function titleOf(payload: Record<string, unknown>): string {
  return typeof payload.title === 'string' ? payload.title : 'undefined';
}

/**
 * Creates an empty store.
 * @param newId Id generator, random ObjectId-like ids by default.
 * @returns Store with grouper logic.
 */
export function createFakeStore(newId: () => string = objectIdLike): FakeStore {
  // Map by project, then by original event id; Map keeps insertion order.
  const projects = new Map<string, Map<string, StoredEvent>>();
  const listeners = new Set<StoreListener>();

  const announce = (projectId: string, event: StoredEvent, isNew: boolean): void => {
    for (const listener of listeners) {
      try {
        listener(projectId, event, isNew);
      } catch {
        // A broken listener is the test's problem, not the store's.
      }
    }
  };

  const eventsOf = (projectId: string): Map<string, StoredEvent> => {
    let events = projects.get(projectId);

    if (!events) {
      events = new Map();
      projects.set(projectId, events);
    }

    return events;
  };

  return {
    ingest(projectId, catcherType, payload) {
      const events = eventsOf(projectId);
      const groupHash = createHash('sha256').update(catcherType + titleOf(payload))
        .digest('hex');
      const existing = [...events.values()].find(event => event.groupHash === groupHash);

      if (existing) {
        const repetitionId = newId();

        existing.totalCount += 1;
        existing.repetitionIds.push(repetitionId);
        existing.lastRepetitionId = repetitionId;
        announce(projectId, existing, false);

        return existing;
      }

      const created: StoredEvent = {
        id: newId(),
        groupHash,
        totalCount: 1,
        catcherType,
        payload,
        repetitionIds: [],
        lastRepetitionId: undefined,
      };

      events.set(created.id, created);
      announce(projectId, created, true);

      return created;
    },
    search(projectId, text) {
      const needle = text.slice(0, SEARCH_LIMIT).toLowerCase();

      return [...eventsOf(projectId).values()].filter((event) => {
        const { context } = event.payload;
        const haystacks = [titleOf(event.payload)];

        if (context !== undefined) {
          haystacks.push(JSON.stringify(context));
        }

        return haystacks.some(haystack => haystack.toLowerCase().includes(needle));
      });
    },
    get: (projectId, eventId) => eventsOf(projectId).get(eventId),
    remove: (projectId, eventId) => eventsOf(projectId).delete(eventId),
    all: projectId => [...eventsOf(projectId).values()],
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
