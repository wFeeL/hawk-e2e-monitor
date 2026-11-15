import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, StageResult } from '../../../src/engine/result.js';
import { runEndpointsProbe } from '../../../src/scenarios/endpoints-probe/run.js';
import type { ProbeOptions } from '../../../src/scenarios/endpoints-probe/run.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { BUNDLE_PATH, startFakeGarage } from '../../support/fake-garage.js';
import type { FakeGarage } from '../../support/fake-garage.js';
import { createTestDeps } from '../../support/scenario.js';
import type { TestDepsOptions } from '../../support/scenario.js';

let hawk: FakeHawk;
let garage: FakeGarage;

beforeEach(async () => {
  hawk = await startFakeHawk();
  garage = await startFakeGarage();
});

afterEach(async () => {
  await hawk.close();
  await garage.close();
});

/**
 * Runs the probe on the fake Hawk.
 * @param setup Environment and clock overrides.
 * @param options Run id and number.
 * @returns Result of the run.
 */
async function probe(setup: TestDepsOptions = {}, options: ProbeOptions = { sequence: 1 }): Promise<RunResult> {
  const { deps } = createTestDeps(hawk, setup);

  return runEndpointsProbe(deps, options);
}

/**
 * Finds a stage in a result.
 * @param result Result whose stages are searched.
 * @param name Stage to look for.
 * @returns The recorded stage; throws when it is missing.
 */
function stageOf(result: RunResult, name: StageResult['name']): StageResult {
  const found = result.stages.find(item => item.name === name);

  if (found === undefined) {
    throw new Error(`Result has no stage ${name}`);
  }

  return found;
}

describe('runEndpointsProbe', () => {
  it('passes with the two availability stages when there is no Garage address, and sends no event', async () => {
    const result = await probe();

    expect(result).toMatchObject({ scenario: 'endpoints-probe',
      status: 'ok',
      sequence: 1,
      sendMayHaveReached: false,
      cleanup: { status: 'skipped' },
      warnings: [] });
    expect(result.stages.map(stage => [stage.name, stage.status])).toEqual([['collector_availability', 'ok'], ['api_availability', 'ok']]);
    expect(result.transport).toBeUndefined();
    expect(result.catcherType).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(result.failedStage).toBeUndefined();
    expect(hawk.collector.posts).toBe(0);
    expect(hawk.store.all(hawk.projectId)).toEqual([]);
  });

  it('adds the garage stage with the bundle it found when there is a Garage address', async () => {
    const result = await probe({ env: { GARAGE_URL: garage.origin } });

    expect(result.status).toBe('ok');
    expect(result.stages.map(stage => stage.name)).toEqual(['collector_availability', 'api_availability', 'garage_availability']);
    expect(stageOf(result, 'garage_availability').details).toMatchObject({ bundle: BUNDLE_PATH });
  });

  it('uses the run id and number it is given', async () => {
    const result = await probe({}, { sequence: 7,
      runId: 'rzzzzzzzzzzzzzzzz' });

    expect(result).toMatchObject({ runId: 'rzzzzzzzzzzzzzzzz',
      sequence: 7 });
  });

  it('makes a wrong-token WebSocket message per probe and nothing else on the collector', async () => {
    await probe();
    await probe();
    await probe();

    expect(hawk.collector.wsMessages).toBe(3);
    expect(hawk.collector.posts).toBe(0);
    expect(hawk.store.all(hawk.projectId)).toEqual([]);
  });

  it('fails at the first failed stage in the order of the stages, with its class', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };
    garage.answer('/', { status: 500,
      contentType: 'text/html',
      body: 'down' });

    const result = await probe({ env: { GARAGE_URL: garage.origin } });

    expect(result.status).toBe('failed');
    expect(result.failedStage).toBe('collector_availability');
    expect(result.errorClass).toBe('collector_dependency_error');
    expect(result.culprit).toBe('hawk');
    // The stages do not wait for each other, so a second failure shows too.
    expect(stageOf(result, 'garage_availability').status).toBe('failed');
    expect(stageOf(result, 'api_availability').status).toBe('ok');
  });

  it('fails on the garage stage with garage_unavailable when the index page has no module script', async () => {
    garage.answer('/', { contentType: 'text/html',
      body: '<!doctype html><html></html>' });

    const result = await probe({ env: { GARAGE_URL: garage.origin } });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'garage_availability',
      errorClass: 'garage_unavailable',
      culprit: 'hawk' });
    expect(result.message).toBe(`Garage at ${garage.origin} did not serve the index page: index.html has no module script`);
  });

  it('fails when the token of the project is not the monitor token', async () => {
    hawk.api.knobs.projectToken = 'not a token';

    const result = await probe();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'api_availability',
      errorClass: 'token_mismatch' });
  });

  it('stops the stages that are still going when the caller cancels the run', async () => {
    const controller = new AbortController();
    const { deps } = createTestDeps(hawk);
    const pending = runEndpointsProbe({ ...deps,
      signal: controller.signal,
      collector: { ...deps.collector,
        health: async (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        }) } }, { sequence: 1 });

    setTimeout(() => {
      controller.abort();
    }, 50);

    const result = await pending;

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_availability',
      errorClass: 'run_timeout' });
    expect(stageOf(result, 'api_availability').status).toBe('ok');
  });

  it('hides the password and the token in the text of a failure', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runEndpointsProbe({ ...deps,
      api: { ...deps.api,
        projectInfo: async () => Promise.reject(new Error(`leak ${hawk.password} ${hawk.token}`)) } }, { sequence: 1 });
    const text = JSON.stringify(result);

    expect(result.status).toBe('failed');
    expect(text).not.toContain(hawk.password);
    expect(text).not.toContain(hawk.token);
  });
});
