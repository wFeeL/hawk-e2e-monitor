import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/errors/taxonomy.js';
import { createHawkApi } from '../../src/clients/hawk-api.js';
import type { HawkApi } from '../../src/clients/hawk-api.js';
import type { GraphqlOperation, GraphqlTransport } from '../../src/clients/graphql.js';
import { systemClock } from '../../src/time/clock.js';

/** One request the stub transport saw. */
interface Seen {
  /** Operation name. */
  name: string;
  /** Variables sent. */
  variables: Readonly<Record<string, unknown>>;
}

/** The stub with what it saw. */
interface Stub {
  /** Client over the stub. */
  api: HawkApi;
  /** Requests after the sign-in. */
  seen: Seen[];
}

const signal = new AbortController().signal;

/**
 * Builds a client whose transport answers from a table.
 * @param operation Operation that is answered.
 * @param answer Data to answer with; an `Error` is thrown.
 * @returns Client and the requests it made.
 */
function stub(operation: string, answer: unknown): Stub {
  const seen: Seen[] = [];
  const transport: GraphqlTransport = {
    request: async <T>(called: GraphqlOperation, variables: Readonly<Record<string, unknown>>): Promise<T> => {
      if (called.name === 'Login') {
        return Promise.resolve({ login: { accessToken: 'a',
          refreshToken: 'r' } } as T);
      }

      seen.push({ name: called.name,
        variables });

      if (called.name !== operation) {
        return Promise.reject(new Error(`unexpected operation ${called.name}`));
      }

      if (answer instanceof Error) {
        return Promise.reject(answer);
      }

      return Promise.resolve(answer as T);
    },
  };

  return { api: createHawkApi({ transport,
    email: 'e',
    password: 'p',
    clock: systemClock,
    retry: { attempts: 1,
      delaysMs: [] } }),
  seen };
}

describe('createProject', () => {
  it('sends the workspace and the name and returns the id and the token', async () => {
    const { api, seen } = stub('CreateProject', { createProject: { id: 'p'.repeat(24),
      name: 'n',
      token: 'tok' } });

    expect(await api.createProject('w'.repeat(24), 'n', signal)).toEqual({ id: 'p'.repeat(24),
      token: 'tok' });
    expect(seen).toEqual([{ name: 'CreateProject',
      variables: { workspaceId: 'w'.repeat(24),
        name: 'n' } }]);
  });

  it('is an api_error when Hawk answers without a project', async () => {
    const { api } = stub('CreateProject', { createProject: null });

    await expect(api.createProject('w', 'n', signal)).rejects.toMatchObject({ errorClass: 'api_error' });
  });

  it('lets the class of a failure through', async () => {
    const { api } = stub('CreateProject', new CheckError('api_unavailable', { code: 'TIMEOUT' }));

    await expect(api.createProject('w', 'n', signal)).rejects.toMatchObject({ errorClass: 'api_unavailable' });
  });
});

describe('removeProject', () => {
  it('sends the project and returns Hawk answer', async () => {
    const { api, seen } = stub('RemoveProject', { removeProject: true });

    expect(await api.removeProject('p'.repeat(24), signal)).toBe(true);
    expect(seen).toEqual([{ name: 'RemoveProject',
      variables: { projectId: 'p'.repeat(24) } }]);
  });

  it('returns false when Hawk says nothing was removed', async () => {
    expect(await stub('RemoveProject', { removeProject: false }).api.removeProject('p', signal)).toBe(false);
  });
});

describe('workspaceProjects', () => {
  it('lists the projects of every workspace with their names and creation times in milliseconds', async () => {
    const { api, seen } = stub('WorkspaceProjects', { workspaces: [
      { id: 'w1',
        projects: [{ id: 'p1',
          name: 'one',
          creationDate: '2026-01-02T03:04:05.000Z' }, null] },
      null,
      { id: 'w2',
        projects: null },
    ] });

    expect(await api.workspaceProjects(['p1', 'p2'], signal)).toEqual([
      { workspaceId: 'w1',
        projects: [{ id: 'p1',
          name: 'one',
          createdAtMs: Date.parse('2026-01-02T03:04:05.000Z') }] },
      { workspaceId: 'w2',
        projects: [] },
    ]);
    expect(seen).toEqual([{ name: 'WorkspaceProjects',
      variables: { ids: ['p1', 'p2'] } }]);
  });

  it('reads a creation time that is a number of seconds or of milliseconds', async () => {
    const { api } = stub('WorkspaceProjects', { workspaces: [{ id: 'w',
      projects: [{ id: 'a',
        name: 'a',
        creationDate: 1_700_000_000 },
      { id: 'b',
        name: 'b',
        creationDate: 1_700_000_000_000 }] }] });
    const [workspace] = await api.workspaceProjects([], signal);

    expect(workspace?.projects.map(project => project.createdAtMs)).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  });

  it('an empty list of ids asks for all projects', async () => {
    const { api, seen } = stub('WorkspaceProjects', { workspaces: [] });

    expect(await api.workspaceProjects([], signal)).toEqual([]);
    expect(seen[0]?.variables).toEqual({ ids: [] });
  });

  it('is an api_error when a creation time cannot be read', async () => {
    const { api } = stub('WorkspaceProjects', { workspaces: [{ id: 'w',
      projects: [{ id: 'a',
        name: 'a',
        creationDate: 'yesterday' }] }] });

    await expect(api.workspaceProjects([], signal)).rejects.toMatchObject({ errorClass: 'api_error' });
  });
});
