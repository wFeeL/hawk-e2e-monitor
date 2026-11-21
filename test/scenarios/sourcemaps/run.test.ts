import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, StageName, StageResult } from '../../../src/engine/result.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { runSourcemaps } from '../../../src/scenarios/sourcemaps/run.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { createTestDeps } from '../../support/scenario.js';
import type { TestDepsOptions } from '../../support/scenario.js';

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Runs the scenario on the fake Hawk.
 * @param options Environment and clock overrides.
 * @returns Result of the run.
 */
async function run(options: TestDepsOptions = {}): Promise<RunResult> {
  const { deps } = createTestDeps(hawk, { ...options,
    env: { SCENARIOS: 'sourcemaps',
      RELEASE_SAVE_TIMEOUT_MS: '600',
      ...options.env } });

  return runSourcemaps(deps, { sequence: 1 });
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
  it('uploads a release, waits until it is saved, sends the event of that release and finds it mapped', async () => {
    const result = await run();

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'sourcemaps',
      catcherType: 'errors/javascript' });
    expect(result.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['collector_availability', 'ok'],
      ['api_availability', 'ok'],
      ['release_uploaded', 'ok'],
      ['release_saved', 'ok'],
      ['collector_accept', 'ok'],
      ['event_visible', 'ok'],
      ['cleanup', 'ok'],
    ]);
    expect(result.title).toBe(`[e2e:fake] ${result.runId} sourcemaps`);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('uses a release of its own for every run, apart from the plain release of the other scenarios', async () => {
    const names: string[] = [];
    const { deps } = createTestDeps(hawk, { env: { SCENARIOS: 'sourcemaps' } });
    const watched = { ...deps,
      collector: { ...deps.collector,
        uploadRelease: async (...args: Parameters<typeof deps.collector.uploadRelease>) => {
          names.push(args[1]);

          return deps.collector.uploadRelease(...args);
        } } };
    const first = await runSourcemaps(watched, { sequence: 1 });
    const second = await runSourcemaps({ ...watched,
      randomLetters: count => 'b'.repeat(count) }, { sequence: 2 });

    expect(names).toEqual([`e2e-fake-${first.runId}`, `e2e-fake-${second.runId}`]);
    expect(names[0]).not.toBe(names[1]);
    expect(names.some(name => name.endsWith('-plain'))).toBe(false);
  });

  it('waits for a release that the worker saves late', async () => {
    hawk.collector.knobs.releaseSaveDelayMs = 250;

    const result = await run();

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'release_saved').details?.attempts).toBeGreaterThan(1);
  });

  it('goes on after an upload whose answer is lost when the release is there', async () => {
    hawk.collector.knobs.replyDelayMs = 400;

    const result = await run({ env: { HTTP_TIMEOUT_MS: '300',
      COLLECTOR_ACCEPT_TIMEOUT_MS: '2000' } });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'release_uploaded').status).toBe('uncertain');
    expect(stageOf(result, 'release_uploaded').details?.degraded).toEqual(['accept_uncertain']);
    expect(stageOf(result, 'release_saved').status).toBe('ok');
    expect(result.warnings.join('\n')).toContain('did not confirm the release');
  });
});

describe('failures', () => {
  it('a source map that is not applied is sourcemap_not_applied, and the event is still removed', async () => {
    hawk.store.knobs.noSourceMaps = true;

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'sourcemap_not_applied',
      culprit: 'hawk' });
    expect(result.message).toContain('backtrace[0].file');
    expect(stageOf(result, 'cleanup').status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('a refused upload is release_rejected and nothing else is tried', async () => {
    hawk.collector.knobs.releaseReply = { status: 400,
      body: '{"code":400,"error":true,"message":"Multipart form is not provided"}' };

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'release_uploaded',
      errorClass: 'release_rejected' });
    expect(stageOf(result, 'release_saved').status).toBe('skipped');
    expect(stageOf(result, 'collector_accept').status).toBe('skipped');
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
  });

  it('a release that never shows is release_not_saved after the time of the stage', async () => {
    hawk.collector.knobs.dropReleases = true;

    const result = await run({ env: { RELEASE_SAVE_TIMEOUT_MS: '400' } });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'release_saved',
      errorClass: 'release_not_saved',
      culprit: 'hawk' });
    expect(stageOf(result, 'collector_accept').status).toBe('skipped');
  });

  it('a release whose upload got a 502 and never shows is blamed on the collector at release_uploaded', async () => {
    hawk.collector.knobs.releaseReply = { status: 502,
      body: 'Bad Gateway' };

    const result = await run({ env: { RELEASE_SAVE_TIMEOUT_MS: '400' } });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'release_uploaded',
      errorClass: 'collector_unavailable',
      culprit: 'hawk' });
    expect(stageOf(result, 'release_uploaded').status).toBe('uncertain');
    expect(stageOf(result, 'release_saved')).toMatchObject({ status: 'failed',
      errorClass: 'release_not_saved' });
    expect(result.message).toBe(stageOf(result, 'release_uploaded').message);
  });

  it('a release without the file of the map is release_not_saved too', async () => {
    const { deps } = createTestDeps(hawk, { env: { SCENARIOS: 'sourcemaps',
      RELEASE_SAVE_TIMEOUT_MS: '400' } });
    const result = await runSourcemaps({ ...deps,
      api: { ...deps.api,
        releaseDetails: async (_projectId, release) => Promise.resolve({ release,
          files: [] }) } }, { sequence: 1 });

    expect(result).toMatchObject({ failedStage: 'release_saved',
      errorClass: 'release_not_saved' });
  });

  it('an API that cannot answer while the release is awaited is its own failure', async () => {
    const { deps } = createTestDeps(hawk, { env: { SCENARIOS: 'sourcemaps',
      RELEASE_SAVE_TIMEOUT_MS: '400' } });
    const result = await runSourcemaps({ ...deps,
      api: { ...deps.api,
        releaseDetails: async () => Promise.reject(new CheckError('api_unavailable', { code: 'ECONNRESET' })) } }, { sequence: 1 });

    expect(result).toMatchObject({ failedStage: 'release_saved',
      errorClass: 'api_unavailable' });
  });

  it('a collector that is down stops the run at the first stage', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'collector_availability',
      errorClass: 'collector_dependency_error' });
    expect(hawk.collector.releasePosts).toBe(0);
  });
});
