import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HawkApi } from '../../../src/clients/hawk-api.js';
import type { RunResult, StageName, StageResult } from '../../../src/engine/result.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { createMutableRedactor } from '../../../src/errors/redact.js';
import { decodeIntegrationToken, tokenKey } from '../../../src/hawk/token.js';
import { runStage } from '../../../src/engine/stages.js';
import { cleanupProjectStage } from '../../../src/scenarios/new-project/stages.js';
import { systemClock } from '../../../src/time/clock.js';
import { createNewProjectContext, runNewProject } from '../../../src/scenarios/new-project/run.js';
import type { NewProjectDeps } from '../../../src/scenarios/new-project/run.js';
import { scenarioSecrets } from '../../../src/scenarios/shared/deps.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createdProjects } from '../../../src/storage/created-projects.js';
import type { CreatedProjects } from '../../../src/storage/created-projects.js';
import { createHistory } from '../../../src/storage/history.js';
import { pendingProjects } from '../../../src/storage/pending-projects.js';
import type { PendingProjects } from '../../../src/storage/pending-projects.js';
import { createSweeper } from '../../../src/cleanup/sweep.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import type { MemoryLogger } from '../../support/logger.js';
import { createTestDeps } from '../../support/scenario.js';
import type { TestDepsOptions } from '../../support/scenario.js';

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/** The pieces of a run on the fake Hawk. */
interface Setup {
  /** Dependencies of the run. */
  deps: NewProjectDeps;
  /** The record of created projects. */
  record: CreatedProjects;
  /** The runs whose project may exist without a known id. */
  pending: PendingProjects;
  /** History under both records. */
  history: ReturnType<typeof createHistory>;
  /** Secrets the run asked to mask. */
  secrets: string[];
  /** Number of collector POSTs seen at the moment each id was recorded. */
  postsAtRecord: number[];
}

/**
 * Builds the dependencies of a run of `new-project`.
 * @param options Environment and clock overrides.
 * @param overrides Dependencies that replace the built ones.
 * @returns Dependencies with a record in memory.
 */
function setup(options: TestDepsOptions = {}, overrides: Partial<NewProjectDeps> = {}): Setup {
  const { deps } = createTestDeps(hawk, { ...options,
    env: { SCENARIOS: 'new-project',
      NEW_PROJECT_TOKEN_TIMEOUT_MS: '2000',
      ...options.env } });
  const history = createHistory(openDatabase(':memory:'));
  const record = createdProjects(history);
  const pending = pendingProjects(history);
  const secrets: string[] = [];
  const postsAtRecord: number[] = [];
  const masking = createMutableRedactor(scenarioSecrets(deps.config));

  return { deps: { ...deps,
    redact: masking.redact,
    addSecret: (value) => {
      secrets.push(value);
      masking.add(value);
    },
    projects: { ids: () => record.ids(),
      forget: (id) => {
        record.forget(id);
      },
      record: (id) => {
        postsAtRecord.push(hawk.collector.posts);
        record.record(id);
      } },
    pending,
    tokenPollMs: 30,
    ...overrides },
  record,
  pending,
  history,
  secrets,
  postsAtRecord };
}

/**
 * Finds a stage of a result.
 * @param result Result of a run.
 * @param name Stage to look for.
 * @returns The recorded stage.
 */
function stageOf(result: RunResult, name: StageName): StageResult {
  const found = result.stages.find(item => item.name === name);

  if (found === undefined) {
    throw new Error(`no stage ${name}`);
  }

  return found;
}

describe('a healthy run', () => {
  it('creates a project, sees its token accepted, finds the event in it and removes the project', async () => {
    const { deps, record, postsAtRecord } = setup();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'new-project',
      transport: 'http' });
    expect(result.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['api_availability', 'ok'],
      ['project_created', 'ok'],
      ['token_accepted', 'ok'],
      ['event_visible', 'ok'],
      ['cleanup', 'ok'],
    ]);
    expect(result.title).toBe(`[e2e:fake] ${result.runId} new-project`);
    expect(result.event?.totalCount).toBe(1);
    expect(stageOf(result, 'token_accepted').details?.tokenAcceptedAfterMs).toBeTypeOf('number');
    expect(hawk.projects.inWorkspace('fake-workspace').map(project => project.id)).toEqual([hawk.projectId]);
    expect(record.ids()).toEqual([]);
    expect(postsAtRecord).toEqual([0]);
  });

  it('names the project after the instance and the run, in the form the sweep expects', async () => {
    let name = '';
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async (workspaceId, projectName, signal) => {
          name = projectName;

          return base.deps.api.createProject(workspaceId, projectName, signal);
        } } }, { sequence: 1 });

    expect(name).toBe(`[e2e:fake] new-project ${result.runId}`);
    expect(name).toMatch(/^\[e2e:fake\] new-project r[a-z]{15}$/u);
  });

  it('masks the token of the new project at once and keeps it out of the result', async () => {
    const { deps, secrets } = setup();
    let token = '';
    const result = await runNewProject({ ...deps,
      api: { ...deps.api,
        createProject: async (workspaceId, name, signal) => {
          const created = await deps.api.createProject(workspaceId, name, signal);

          token = created.token;

          return created;
        } } }, { sequence: 1 });
    const decoded = decodeIntegrationToken(token);

    expect(secrets).toContain(token);
    expect(secrets).toContain(decoded?.secret);
    expect(secrets).toContain(tokenKey(decoded ?? { integrationId: '',
      secret: '' }));
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(decoded?.secret ?? 'unreachable');
  });

  it('waits for a collector that loads the token late and reports how long it took', async () => {
    hawk.projects.knobs.tokenReloadMs = 300;

    const { deps } = setup();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'token_accepted').details?.tokenAcceptedAfterMs).toBeGreaterThanOrEqual(250);
    expect(stageOf(result, 'token_accepted').details?.attempts).toBeGreaterThan(1);
  });
});

describe('failures', () => {
  it('a token that is accepted too late is new_token_not_accepted, and the project is still removed', async () => {
    hawk.projects.knobs.tokenReloadMs = 60_000;

    const { deps, record } = setup({ env: { NEW_PROJECT_TOKEN_TIMEOUT_MS: '400' } });
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'token_accepted',
      errorClass: 'new_token_not_accepted',
      culprit: 'hawk' });
    expect(stageOf(result, 'event_visible').status).toBe('skipped');
    expect(stageOf(result, 'cleanup').status).toBe('ok');
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(1);
    expect(record.ids()).toEqual([]);
  });

  it('another answer of the collector ends the wait at once with its own class', async () => {
    hawk.collector.knobs.reply = () => ({ status: 402,
      body: JSON.stringify({ code: 402,
        error: true,
        message: 'Project has exceeded the events limit' }) });

    const { deps } = setup();
    const started = Date.now();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'token_accepted',
      errorClass: 'quota_exhausted' });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(stageOf(result, 'cleanup').status).toBe('ok');
  });

  it('a project that cannot be created fails project_created and has nothing to clean up', async () => {
    hawk.api.knobs.notAdmin = true;

    const { deps, record, pending } = setup();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'project_created',
      errorClass: 'api_forbidden' });
    expect(stageOf(result, 'token_accepted').status).toBe('skipped');
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
    expect(record.ids()).toEqual([]);
    expect(pending.list()).toEqual([]);
  });

  it('a failed removal is cleanup_failed, fails the run and keeps the id for the sweep', async () => {
    hawk.api.knobs.errors = Object.fromEntries([['RemoveProject', { code: 'INTERNAL_SERVER_ERROR',
      message: 'boom' }]]);

    const { deps, record } = setup();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'cleanup',
      errorClass: 'cleanup_failed' });
    expect(result.cleanup.status).toBe('failed');
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(2);
    expect(record.ids()).toHaveLength(1);
  });

  it('a project that is already gone at cleanup counts as removed', async () => {
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        removeProject: async (projectId, signal) => {
          await base.deps.api.removeProject(projectId, signal);

          throw new CheckError('api_error', { detail: 'There is no project with that id' });
        } } }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(base.record.ids()).toEqual([]);
  });

  it('a lost answer of createProject is recovered by the name of the project', async () => {
    const base = setup();
    const lost: HawkApi = { ...base.deps.api,
      createProject: async (workspaceId, name, signal) => {
        await base.deps.api.createProject(workspaceId, name, signal);

        throw new CheckError('api_unavailable', { code: 'TIMEOUT' });
      } };
    const result = await runNewProject({ ...base.deps,
      api: lost }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(result.warnings.join('\n')).toContain('did not confirm the creation in time');
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(1);
    expect(base.record.ids()).toEqual([]);
  });

  it('a create that fails after the project was made fails the run and the project is removed', async () => {
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async (workspaceId, name, signal) => {
          await base.deps.api.createProject(workspaceId, name, signal);

          throw new CheckError('api_error', { detail: 'index failed' });
        } } }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'project_created',
      errorClass: 'api_error' });
    expect(result.warnings.join('\n')).toContain('yet the project was created');
    // The one project left is the monitored one.
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(1);
    expect(base.record.ids()).toEqual([]);
    expect(base.pending.list()).toEqual([]);
  });

  it('a lost answer for a project that was never made is the original failure', async () => {
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async () => Promise.reject(new CheckError('api_unavailable', { code: 'TIMEOUT' })) } }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'project_created',
      errorClass: 'api_unavailable' });
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
  });

  it('a blocked workspace stops before anything is created', async () => {
    hawk.api.knobs.workspace = { isBlocked: true,
      eventsLimit: 100,
      billingPeriodEventsCount: 0 };

    const { deps } = setup();
    const result = await runNewProject(deps, { sequence: 1 });

    expect(result).toMatchObject({ failedStage: 'api_availability',
      errorClass: 'workspace_blocked' });
    expect(hawk.projects.inWorkspace('fake-workspace')).toHaveLength(1);
  });

  it('never removes the monitored project', async () => {
    const base = setup();
    const { context } = createNewProjectContext(base.deps, { sequence: 1 });

    context.created = { id: hawk.projectId,
      token: hawk.token };

    const stage = await runStage(cleanupProjectStage(1000), context, { clock: systemClock,
      runSignal: new AbortController().signal });

    expect(stage).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_refused' });
    expect(stage.message).toContain('monitored');
    expect(hawk.projects.has(hawk.projectId)).toBe(true);
  });
});

describe('a project whose id the monitor may not learn', () => {
  const WARNING = 'The project of this run may still be created in Hawk; the sweep removes it';

  /**
   * Makes `createProject` fail without creating anything.
   * @param base Dependencies of the run.
   * @param error What it throws.
   * @returns Dependencies with the failing call.
   */
  function failing(base: Setup, error: CheckError): NewProjectDeps {
    return { ...base.deps,
      api: { ...base.deps.api,
        createProject: async () => Promise.reject(error) } };
  }

  it('a lost create is kept as pending with a warning, and the next sweep pass removes the project and drops the entry', async () => {
    const base = setup();
    let name = '';
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async (_workspaceId, projectName) => {
          name = projectName;

          return Promise.reject(new CheckError('api_unavailable', { code: 'TIMEOUT' }));
        } } }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'project_created' });
    expect(result.warnings).toContain(WARNING);
    expect(base.pending.list()).toHaveLength(1);
    expect(name).toBe(`[e2e:${base.deps.config.instanceId}] new-project ${base.pending.list()[0]?.runId ?? ''}`);

    // The project shows up after the stage gave up.
    const project = hawk.projects.create('fake-workspace', name);

    if (project === undefined) {
      throw new Error('the fake did not create the project');
    }

    const runId = base.pending.list()[0]?.runId ?? '';

    project.creationDate = Date.now() - 2 * 3_600_000;
    base.pending.drop(runId);
    base.pending.add(runId, new Date(Date.now() - 2 * 3_600_000).toISOString());

    const sweeper = createSweeper({ api: base.deps.api,
      history: base.history,
      clock: systemClock,
      logger: base.deps.logger,
      config: base.deps.config,
      activeRunIds: () => new Set() });
    const report = await sweeper.sweepOnce(new AbortController().signal);

    expect(report.projects).toMatchObject({ removed: 1 });
    expect(hawk.projects.has(project.id)).toBe(false);
    expect(base.pending.list()).toEqual([]);
  });

  it.each([
    ['a refused connection', new CheckError('api_unavailable', { code: 'ECONNREFUSED' })],
    ['an unknown host', new CheckError('dns_error', {})],
    ['a rejected query', new CheckError('api_query_rejected', { detail: 'no' })],
    ['a failed login', new CheckError('api_auth_failed', {})],
    ['a forbidden account', new CheckError('api_forbidden', {})],
  ])('%s made nothing: the entry is dropped and there is no warning', async (_label, error) => {
    const base = setup();
    const result = await runNewProject(failing(base, error), { sequence: 1 });

    expect(result.status).toBe('failed');
    expect(result.warnings).not.toContain(WARNING);
    expect(base.pending.list()).toEqual([]);
  });

  it.each([
    ['an internal error of Hawk', new CheckError('api_error', { detail: 'index failed' })],
    ['a timeout', new CheckError('api_unavailable', { code: 'TIMEOUT' })],
  ])('%s may have made the project: the entry stays and the name is looked up', async (_label, error) => {
    const base = setup();
    const result = await runNewProject(failing(base, error), { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'project_created' });
    expect(result.warnings).toContain(WARNING);
    expect(base.pending.list()).toHaveLength(1);
    expect(hawk.api.operations).toContain('WorkspaceProjects');
  });

  it('a lookup that throws keeps the entry, adds the warning and is logged', async () => {
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async () => Promise.reject(new CheckError('api_unavailable', { code: 'TIMEOUT' })),
        workspaceProjects: async () => Promise.reject(new CheckError('api_error', { detail: 'down' })) } }, { sequence: 1 });

    expect(result.warnings).toContain(WARNING);
    expect(base.pending.list()).toHaveLength(1);
    expect((base.deps.logger as MemoryLogger).lines).toContainEqual(expect.objectContaining({ level: 'warn',
      msg: 'could not look for the created project' }));
  });

  it('a project that is created is recorded and its pending entry dropped', async () => {
    const base = setup();
    const result = await runNewProject(base.deps, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(base.pending.list()).toEqual([]);
  });

  it('a project found by its name after a lost answer is recorded and its pending entry dropped', async () => {
    const base = setup();
    const result = await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async (workspaceId, name, signal) => {
          await base.deps.api.createProject(workspaceId, name, signal);

          throw new CheckError('api_unavailable', { code: 'TIMEOUT' });
        } } }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(result.warnings.join('\n')).toContain('did not confirm the creation in time');
    expect(base.pending.list()).toEqual([]);
  });

  it('writes the entry before the project is asked for', async () => {
    const base = setup();
    const seen: number[] = [];

    await runNewProject({ ...base.deps,
      api: { ...base.deps.api,
        createProject: async (workspaceId, name, signal) => {
          seen.push(base.pending.list().length);

          return base.deps.api.createProject(workspaceId, name, signal);
        } } }, { sequence: 1 });

    expect(seen).toEqual([1]);
  });
});
