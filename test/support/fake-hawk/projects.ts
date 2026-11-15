import { randomUUID } from 'node:crypto';
import { objectIdLike } from './store.js';
import { decodeTokenKey, encodeToken } from './token.js';

/** A project of the fake Hawk. */
export interface FakeProject {
  /** 24 hex characters. */
  id: string;
  /** Name shown in the workspace. */
  name: string;
  /** Workspace that holds the project. */
  workspaceId: string;
  /** Creation time, ms. */
  creationDate: number;
  /** Integration token. */
  token: string;
  /** `integrationId + secret` without dashes, the key the collector looks up. */
  tokenKey: string;
  /** Time from which the collector knows the token, ms. */
  activeAtMs: number;
}

/** What `add` takes: a project that exists already, so the collector knows it from the start. */
export interface FakeProjectInput {
  /** 24 hex characters. */
  id: string;
  /** Name shown in the workspace. */
  name: string;
  /** Workspace that holds the project. */
  workspaceId: string;
  /** Integration token. */
  token: string;
  /** Creation time, now by default. */
  creationDate?: number;
}

/** Switches of the registry. */
export interface FakeProjectsKnobs {
  /** How long after a project is created the collector still refuses its token, ms; 0 by default. */
  tokenReloadMs?: number;
}

/** Workspaces and projects of the fake Hawk, shared by its API and its collector. */
export interface FakeProjects {
  /** Mutable switches. */
  readonly knobs: FakeProjectsKnobs;
  /**
   * Adds a workspace; one that exists stays as it is.
   * @param workspaceId Id of the workspace to add.
   */
  addWorkspace(workspaceId: string): void;
  /**
   * Lists the workspaces in the order they were added.
   * @returns Workspace ids.
   */
  workspaces(): string[];
  /**
   * Adds a project that already exists in Hawk, such as the monitored one.
   * @param input Project fields.
   * @returns The project.
   */
  add(input: FakeProjectInput): FakeProject;
  /**
   * Creates a project the way `createProject` does: new id, new token, known to the collector after the reload time.
   * @param workspaceId Workspace to create it in.
   * @param name Project name.
   * @returns The project, undefined when the workspace does not exist.
   */
  create(workspaceId: string, name: string): FakeProject | undefined;
  /**
   * Removes a project.
   * @param projectId Id of the project to remove.
   * @returns Whether it existed.
   */
  remove(projectId: string): boolean;
  /**
   * Finds a project.
   * @param projectId Id of the project to look for.
   * @returns The project or undefined.
   */
  get(projectId: string): FakeProject | undefined;
  /**
   * Tells whether a project exists.
   * @param projectId Id of the project to look for.
   * @returns True when it does.
   */
  has(projectId: string): boolean;
  /**
   * Lists the projects of a workspace in creation order.
   * @param workspaceId Id of the workspace to list.
   * @returns Projects of that workspace.
   */
  inWorkspace(workspaceId: string): FakeProject[];
  /**
   * Finds the project whose token the collector knows at this moment.
   * @param key `integrationId + secret` without dashes.
   * @returns The project, undefined for an unknown token or one that is not loaded yet.
   */
  byTokenKey(key: string): FakeProject | undefined;
}

/**
 * Creates an empty registry.
 * @param now Time source in ms, `Date.now` by default.
 * @returns Registry with no workspaces.
 */
export function createFakeProjects(now: () => number = Date.now): FakeProjects {
  const knobs: FakeProjectsKnobs = {};
  const known: string[] = [];
  const projects = new Map<string, FakeProject>();

  const keyOf = (token: string): string => decodeTokenKey(token) ?? token;

  const add: FakeProjects['add'] = (input) => {
    const project: FakeProject = { ...input,
      creationDate: input.creationDate ?? now(),
      tokenKey: keyOf(input.token),
      activeAtMs: 0 };

    projects.set(project.id, project);

    return project;
  };

  return {
    knobs,
    addWorkspace: (workspaceId) => {
      if (!known.includes(workspaceId)) {
        known.push(workspaceId);
      }
    },
    workspaces: () => [...known],
    add,
    create: (workspaceId, name) => {
      if (!known.includes(workspaceId)) {
        return undefined;
      }

      const project = add({ id: objectIdLike(),
        name,
        workspaceId,
        token: encodeToken(randomUUID(), randomUUID()) });

      project.activeAtMs = now() + (knobs.tokenReloadMs ?? 0);

      return project;
    },
    remove: projectId => projects.delete(projectId),
    get: projectId => projects.get(projectId),
    has: projectId => projects.has(projectId),
    inWorkspace: workspaceId => [...projects.values()].filter(project => project.workspaceId === workspaceId),
    byTokenKey: key => [...projects.values()].find(project => project.tokenKey === key && now() >= project.activeAtMs),
  };
}
