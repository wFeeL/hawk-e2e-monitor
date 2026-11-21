import { afterEach, describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from '../../../src/clients/operations.js';
import { decodeIntegrationToken, tokenKey } from '../../../src/hawk/token.js';
import { startFakeHawk } from './index.js';
import type { FakeHawk } from './index.js';
import { createFakeProjects } from './projects.js';
import { encodeToken } from './token.js';

const hawks: FakeHawk[] = [];

/** GraphQL error as the tests read it. */
interface ErrorShape {
  /** Message. */
  message: string;
  /** Extensions with the code. */
  extensions: Record<'code', string>;
}

/** A project in a raw answer. */
interface ProjectShape {
  /** Id. */
  id: string;
  /** Name. */
  name: string;
  /** Token. */
  token: string;
  /** Creation date. */
  creationDate: string;
}

/** A workspace with its projects. */
interface WorkspaceShape {
  /** Id. */
  id: string;
  /** Projects of the workspace. */
  projects: ProjectShape[];
}

/** A notification rule as far as the tests look. */
interface RuleShape {
  /** What the rule tells about. */
  whatToReceive: string;
  /** Threshold of the rule. */
  threshold: number | null;
}

/** The project selections the tests read. */
interface ProjectSelection {
  /** Integration token. */
  token: string;
  /** Notification rules. */
  notifications: RuleShape[];
  /** Search results. */
  dailyEventsPortion: Record<'dailyEvents', unknown[]>;
}

/** The data the tests read. */
interface DataShape {
  /** Sign-in. */
  login: Record<'accessToken', string>;
  /** `CreateProject` result. */
  createProject: ProjectShape;
  /** `RemoveProject` result. */
  removeProject: boolean;
  /** Workspaces of `WorkspaceProjects` or `WorkspaceQuota`. */
  workspaces: WorkspaceShape[];
  /** `ProjectToken` and notification selections. */
  project: ProjectSelection;
}

/** A parsed answer. */
interface Answer {
  /** Data, if any. */
  data?: DataShape;
  /** Errors, if any. */
  errors?: ErrorShape[];
}

/**
 * Starts a fake Hawk that closes after the test.
 * @returns Fake Hawk.
 */
async function start(): Promise<FakeHawk> {
  const hawk = await startFakeHawk();

  hawks.push(hawk);

  return hawk;
}

/**
 * Sends one GraphQL operation of the fake API.
 * @param hawk Fake Hawk.
 * @param operationName Name of the operation to send.
 * @param variables Values of the operation variables.
 * @param accessToken Bearer token of the signed-in account.
 * @returns Parsed body.
 */
async function gql(hawk: FakeHawk, operationName: string, variables: Record<string, unknown>, accessToken?: string): Promise<Answer> {
  const response = await fetch(hawk.api.url, { method: 'POST',
    headers: new Headers([['content-type', 'application/json'], ...accessToken === undefined ? [] : [['authorization', `Bearer ${accessToken}`] as [string, string]]]),
    body: JSON.stringify({ operationName,
      query: ALL_OPERATIONS.find(operation => operation.name === operationName)?.document ?? 'query Unknown { x }',
      variables }) });

  return await response.json() as Answer;
}

/**
 * Signs in.
 * @param hawk Fake Hawk.
 * @returns Access token.
 */
async function signIn(hawk: FakeHawk): Promise<string> {
  const answer = await gql(hawk, 'Login', { email: hawk.email,
    password: hawk.password });

  return answer.data?.login.accessToken ?? '';
}

/**
 * Creates a project through the API.
 * @param hawk Fake Hawk.
 * @param name Project name.
 * @returns The new project.
 */
async function create(hawk: FakeHawk, name = 'new one'): Promise<ProjectShape> {
  const token = await signIn(hawk);
  const answer = await gql(hawk, 'CreateProject', { workspaceId: 'fake-workspace',
    name }, token);

  if (!answer.data) {
    throw new Error(`Expected a project, got ${JSON.stringify(answer)}`);
  }

  return answer.data.createProject;
}

/**
 * Posts an event to the collector.
 * @param hawk Fake Hawk.
 * @param token Integration token.
 * @returns HTTP status and body text.
 */
async function send(hawk: FakeHawk, token: string): Promise<[number, string]> {
  const response = await fetch(hawk.collector.url, { method: 'POST',
    body: JSON.stringify({ token,
      catcherType: 'errors/nodejs',
      payload: { title: 'from the new project' } }) });

  return [response.status, await response.text()];
}

afterEach(async () => {
  await Promise.all(hawks.splice(0).map(async hawk => hawk.close()));
});

describe('fake projects', () => {
  it('knows workspaces and their projects', () => {
    const projects = createFakeProjects();

    projects.addWorkspace('w1');
    projects.addWorkspace('w2');

    const one = projects.add({ id: 'p1',
      name: 'one',
      workspaceId: 'w1',
      token: encodeToken('a', 'b') });

    expect(projects.workspaces()).toEqual(['w1', 'w2']);
    expect(projects.get('p1')).toBe(one);
    expect(projects.has('p2')).toBe(false);
    expect(projects.inWorkspace('w1')).toEqual([one]);
    expect(projects.inWorkspace('w2')).toEqual([]);
  });

  it('creates a project with a fresh id and token and nothing in an unknown workspace', () => {
    const projects = createFakeProjects();

    projects.addWorkspace('w1');

    const made = projects.create('w1', 'n');

    expect(made?.id).toMatch(/^[0-9a-f]{24}$/u);
    expect(decodeIntegrationToken(made?.token ?? '')).toBeDefined();
    expect(projects.create('nope', 'n')).toBeUndefined();
    expect(projects.create('w1', 'n')?.id).not.toBe(made?.id);
  });

  it('shows the token to the collector only after the reload time', () => {
    const time = { value: 1000 };
    const projects = createFakeProjects(() => time.value);

    projects.addWorkspace('w1');
    projects.knobs.tokenReloadMs = 500;

    const made = projects.create('w1', 'n');
    const key = tokenKey(decodeIntegrationToken(made?.token ?? '') ?? { integrationId: '',
      secret: '' });

    expect(projects.byTokenKey(key)).toBeUndefined();
    time.value = 1499;
    expect(projects.byTokenKey(key)).toBeUndefined();
    time.value = 1500;
    expect(projects.byTokenKey(key)).toBe(made);
  });

  it('forgets a removed project, its token too', () => {
    const projects = createFakeProjects();

    projects.addWorkspace('w1');

    const made = projects.create('w1', 'n');
    const key = tokenKey(decodeIntegrationToken(made?.token ?? '') ?? { integrationId: '',
      secret: '' });

    expect(projects.remove(made?.id ?? '')).toBe(true);
    expect(projects.remove(made?.id ?? '')).toBe(false);
    expect(projects.byTokenKey(key)).toBeUndefined();
    expect(projects.has(made?.id ?? '')).toBe(false);
  });
});

describe('fake hawk with several projects', () => {
  it('keeps the main project in its workspace next to a foreign one', async () => {
    const hawk = await start();

    expect(hawk.projects.get(hawk.projectId)?.workspaceId).toBe('fake-workspace');
    expect(hawk.projects.workspaces()).toEqual(['foreign-workspace', 'fake-workspace']);
  });

  it('CreateProject makes a project with a token, the default rule and a place in the list', async () => {
    const hawk = await start();
    const made = await create(hawk);
    const token = await signIn(hawk);

    expect(made).toMatchObject({ name: 'new one' });
    expect(decodeIntegrationToken(made.token)).toBeDefined();

    const info = await gql(hawk, 'ProjectToken', { projectId: made.id }, token);

    expect(info.data?.project.token).toBe(made.token);

    const rules = await gql(hawk, 'NotificationRules', { projectId: made.id }, token);

    expect(rules.data?.project.notifications).toHaveLength(1);
    expect(rules.data?.project.notifications[0]).toMatchObject({ whatToReceive: 'SEEN_MORE',
      threshold: 20 });

    const listed = await gql(hawk, 'WorkspaceProjects', { ids: [] }, token);
    const workspace = listed.data?.workspaces.find(item => item.id === 'fake-workspace');

    expect(workspace?.projects.map(project => project.id)).toEqual([hawk.projectId, made.id]);
    expect(Date.parse(workspace?.projects[1]?.creationDate ?? '')).toBeGreaterThan(Date.now() - 5000);
  });

  it('WorkspaceProjects narrows the list to the asked ids and shows foreign workspaces', async () => {
    const hawk = await start();
    const made = await create(hawk);
    const token = await signIn(hawk);

    hawk.projects.add({ id: 'f'.repeat(24),
      name: made.name,
      workspaceId: 'foreign-workspace',
      token: encodeToken('x', 'y') });

    const listed = await gql(hawk, 'WorkspaceProjects', { ids: [made.id, 'f'.repeat(24)] }, token);

    expect(listed.data?.workspaces.map(item => [item.id, item.projects.map(project => project.id)])).toEqual([
      ['foreign-workspace', ['f'.repeat(24)]],
      ['fake-workspace', [made.id]],
    ]);
  });

  it('WorkspaceQuota finds the workspace of a new project', async () => {
    const hawk = await start();
    const made = await create(hawk);
    const answer = await gql(hawk, 'WorkspaceQuota', { projectId: made.id }, await signIn(hawk));

    expect(answer.data?.workspaces.find(item => item.projects.length > 0)?.id).toBe('fake-workspace');
  });

  it('CreateProject in an unknown workspace is BAD_USER_INPUT, without admin rights FORBIDDEN', async () => {
    const hawk = await start();
    const token = await signIn(hawk);
    const missing = await gql(hawk, 'CreateProject', { workspaceId: 'nope',
      name: 'x' }, token);

    expect(missing.errors?.[0]).toMatchObject({ message: 'No such workspace',
      extensions: { code: 'BAD_USER_INPUT' } });

    hawk.api.knobs.notAdmin = true;

    const refused = await gql(hawk, 'CreateProject', { workspaceId: 'fake-workspace',
      name: 'x' }, token);

    expect(refused.errors?.[0]).toMatchObject({ message: 'Not enough permissions',
      extensions: { code: 'FORBIDDEN' } });
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(1);
  });

  it('the collector takes the token of the new project after the reload time and files the event under it', async () => {
    const hawk = await start();

    hawk.projects.knobs.tokenReloadMs = 150;

    const made = await create(hawk);
    const [early, message] = await send(hawk, made.token);

    expect(early).toBe(400);
    expect(message).toContain('Integration token invalid');

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    expect((await send(hawk, made.token))[0]).toBe(200);
    expect(hawk.store.all(made.id)).toHaveLength(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);

    const token = await signIn(hawk);
    const found = await gql(hawk, 'ProjectDailyEvents', { projectId: made.id,
      search: 'from the new project' }, token);

    expect(found.data?.project.dailyEventsPortion.dailyEvents).toHaveLength(1);
  });

  it('the main token still works', async () => {
    const hawk = await start();

    expect((await send(hawk, hawk.token))[0]).toBe(200);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(1);
  });

  it('RemoveProject takes the project, its events, rules and token away, whoever asks', async () => {
    const hawk = await start();
    const made = await create(hawk);

    await send(hawk, made.token);
    hawk.api.knobs.notAdmin = true;

    const token = await signIn(hawk);
    const removed = await gql(hawk, 'RemoveProject', { projectId: made.id }, token);

    expect(removed.data?.removeProject).toBe(true);
    expect(hawk.projects.has(made.id)).toBe(false);
    expect(hawk.store.all(made.id)).toHaveLength(0);
    expect(hawk.rules.list(made.id)).toHaveLength(0);
    expect((await send(hawk, made.token))[0]).toBe(400);

    const again = await gql(hawk, 'RemoveProject', { projectId: made.id }, token);

    expect(again.errors?.[0]).toMatchObject({ message: 'There is no project with that id',
      extensions: { code: 'INTERNAL_SERVER_ERROR' } });
  });

  it('can remove the main project too, since Hawk does not check', async () => {
    const hawk = await start();

    expect((await gql(hawk, 'RemoveProject', { projectId: hawk.projectId }, await signIn(hawk))).data?.removeProject).toBe(true);
  });

  it('refuses project operations on a project nobody registered', async () => {
    const hawk = await start();
    const answer = await gql(hawk, 'ProjectToken', { projectId: 'c'.repeat(24) }, await signIn(hawk));

    expect(answer.errors?.[0]?.extensions.code).toBe('FORBIDDEN');
  });
});
