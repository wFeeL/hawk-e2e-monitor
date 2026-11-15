import type { History } from './history.js';
import { NEW_PROJECT_KEY } from './keys.js';

const PROJECT_ID_PATTERN = /^[0-9a-f]{24}$/u;

/** The projects `new-project` created and has not removed yet; the sweep removes what is left. */
export interface CreatedProjects {
  /**
   * Lists the recorded ids.
   * @returns Ids in the order they were recorded; empty when the record is missing or damaged.
   */
  ids(): string[];
  /**
   * Records an id, before anything is sent to the new project.
   * @param projectId 24-character hex id of the project.
   */
  record(projectId: string): void;
  /**
   * Forgets an id once the project is gone.
   * @param projectId 24-character hex id of the project.
   */
  forget(projectId: string): void;
}

/**
 * Keeps the record of created projects in the key-value table of the history.
 * @param history History whose `kv` holds the record.
 * @returns Record over that table.
 */
export function createdProjects(history: Pick<History, 'deleteKv' | 'getKv' | 'setKv'>): CreatedProjects {
  const ids = (): string[] => {
    try {
      const parsed: unknown = JSON.parse(history.getKv(NEW_PROJECT_KEY) ?? '[]');

      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && PROJECT_ID_PATTERN.test(item)) : [];
    } catch {
      return [];
    }
  };
  const write = (list: readonly string[]): void => {
    if (list.length === 0) {
      history.deleteKv(NEW_PROJECT_KEY);
    } else {
      history.setKv(NEW_PROJECT_KEY, JSON.stringify(list));
    }
  };

  return {
    ids,
    record: (projectId) => {
      const known = ids();

      if (!known.includes(projectId)) {
        write([...known, projectId]);
      }
    },
    forget: (projectId) => {
      write(ids().filter(id => id !== projectId));
    },
  };
}
