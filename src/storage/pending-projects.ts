import type { History } from './history.js';
import { NEW_PROJECT_PENDING_KEY } from './keys.js';

const RUN_ID_PATTERN = /^[a-z]{16}$/u;

/** A run that asked Hawk for a project and has not learned its id. */
export interface PendingProject {
  /** Id of the run, which is part of the project's name. */
  runId: string;
  /** When the run asked, as an ISO time. */
  at: string;
}

/** The runs of `new-project` whose project may exist in Hawk without the monitor knowing its id; the sweep looks for them by name. */
export interface PendingProjects {
  /**
   * Lists the pending runs.
   * @returns Runs in the order they were added; empty when the record is missing or damaged.
   */
  list(): PendingProject[];
  /**
   * Adds a run before the project is asked for; a run that is already there keeps its first time.
   * @param runId 16-letter run id.
   * @param at Time of the request, as an ISO string.
   */
  add(runId: string, at: string): void;
  /**
   * Drops a run once its project is known or surely was not made.
   * @param runId 16-letter run id.
   */
  drop(runId: string): void;
}

/**
 * Keeps the pending runs in the key-value table of the history.
 * @param history History whose `kv` holds the record.
 * @returns Record over that table.
 */
export function pendingProjects(history: Pick<History, 'deleteKv' | 'getKv' | 'setKv'>): PendingProjects {
  const list = (): PendingProject[] => {
    try {
      const parsed: unknown = JSON.parse(history.getKv(NEW_PROJECT_PENDING_KEY) ?? '[]');

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.flatMap((item: unknown) => {
        const entry = item as Partial<PendingProject> | null;

        return typeof entry?.runId === 'string' && RUN_ID_PATTERN.test(entry.runId)
          && typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at))
          ? [{ runId: entry.runId,
              at: entry.at }]
          : [];
      });
    } catch {
      return [];
    }
  };
  const write = (entries: readonly PendingProject[]): void => {
    if (entries.length === 0) {
      history.deleteKv(NEW_PROJECT_PENDING_KEY);
    } else {
      history.setKv(NEW_PROJECT_PENDING_KEY, JSON.stringify(entries));
    }
  };

  return {
    list,
    add: (runId, at) => {
      const known = list();

      if (!known.some(entry => entry.runId === runId)) {
        write([...known, { runId,
          at }]);
      }
    },
    drop: (runId) => {
      write(list().filter(entry => entry.runId !== runId));
    },
  };
}
