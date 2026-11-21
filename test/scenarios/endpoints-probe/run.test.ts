import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, StageResult } from '../../../src/engine/result.js';
import { createMutableRedactor } from '../../../src/errors/redact.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { probeReceiver } from '../../../src/notifications/address.js';
import { runEndpointsProbe } from '../../../src/scenarios/endpoints-probe/run.js';
import type { ProbeOptions } from '../../../src/scenarios/endpoints-probe/run.js';
import type { ReceiverCheck } from '../../../src/scenarios/endpoints-probe/stages.js';
import { httpAddress } from '../../support/address.js';
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

/**
 * Builds a receiver check that answers well unless a part is replaced.
 * @param replace Parts of the check to swap for others.
 * @returns A check with every part filled.
 */
function receiverCheck(replace: Partial<ReceiverCheck> = {}): ReceiverCheck {
  return { findAddress: async () => Promise.resolve(httpAddress(1)),
    probe: async () => Promise.resolve(),
    tunnelWaited: () => true,
    addSecret: () => undefined,
    ...replace };
}

describe('runEndpointsProbe with a receiver check', () => {
  let receiver: Server | undefined;

  afterEach(async () => {
    const closing = receiver;

    receiver = undefined;

    if (closing) {
      closing.closeAllConnections();
      await new Promise<void>((resolve) => {
        closing.close(() => {
          resolve();
        });
      });
    }
  });

  /**
   * Runs the probe with a receiver check.
   * @param check Check to give.
   * @param deps Other replacements of the dependencies.
   * @returns Result of the run.
   */
  async function probeWith(check: ReceiverCheck | undefined, deps: Partial<Parameters<typeof runEndpointsProbe>[0]> = {}): Promise<RunResult> {
    const { deps: base } = createTestDeps(hawk);

    return runEndpointsProbe({ ...base,
      ...deps,
      ...check === undefined ? {} : { receiverCheck: check } }, { sequence: 1 });
  }

  it('adds receiver_availability last, ok when the address is found and the receiver answers', async () => {
    const result = await probeWith(receiverCheck());

    expect(result.status).toBe('ok');
    expect(result.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['collector_availability', 'ok'],
      ['api_availability', 'ok'],
      ['receiver_availability', 'ok'],
    ]);
  });

  it('adds no such stage without a receiver check', async () => {
    const result = await probeWith(undefined);

    expect(result.stages.map(stage => stage.name)).not.toContain('receiver_availability');
  });

  it('fails at receiver_availability with tunnel_unavailable when the tunnel gives no address', async () => {
    const result = await probeWith(receiverCheck({ findAddress: async () => Promise.reject(new CheckError('tunnel_unavailable', { detail: 'no tunnel' })) }));

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'receiver_availability',
      errorClass: 'tunnel_unavailable',
      culprit: 'monitor' });
  });

  it('keeps receiver_unreachable and masks the host of an address that answers 530', async () => {
    receiver = createServer((req, res) => {
      req.resume();
      res.statusCode = 530;
      res.end();
    });
    await new Promise<void>((resolve) => {
      receiver?.listen(0, '127.0.0.1', resolve);
    });

    const address = httpAddress((receiver.address() as AddressInfo).port, 'tunnel');
    const masking = createMutableRedactor([]);
    const { deps: base } = createTestDeps(hawk);
    const result = await runEndpointsProbe({ ...base,
      redact: masking.redact,
      receiverCheck: receiverCheck({ findAddress: async () => Promise.resolve(address),
        probe: async (found, signal) => probeReceiver(found, 'secret', 'nonce', { httpTimeoutMs: 500,
          clock: base.clock,
          attempts: 1,
          retry: base.config.retry }, signal),
        addSecret: masking.add }) }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'receiver_availability',
      errorClass: 'receiver_unreachable' });
    expect(result.message).toContain('answered HTTP 530');
    expect(JSON.stringify(result)).not.toContain(address.hostname);
  });

  it('names the collector first when the collector and the tunnel fail in one run', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await probeWith(receiverCheck({ findAddress: async () => Promise.reject(new CheckError('tunnel_unavailable', { detail: 'no tunnel' })) }));

    expect(result.failedStage).toBe('collector_availability');
    expect(result.stages.find(stage => stage.name === 'receiver_availability')?.status).toBe('failed');
  });

  it('skips the stage with tunnel_starting while the first wait for the tunnel is pending, and the run is ok', async () => {
    let looked = false;
    const result = await probeWith(receiverCheck({ tunnelWaited: () => false,
      findAddress: async () => {
        looked = true;

        return Promise.resolve(httpAddress(1));
      } }));

    expect(result.status).toBe('ok');
    expect(result.stages.find(stage => stage.name === 'receiver_availability')).toMatchObject({ status: 'skipped',
      details: { reason: 'tunnel_starting' } });
    expect(looked).toBe(false);
  });

  it('gives the redactor the base url, the hostname and the bare hostname before the probe', async () => {
    const added: string[] = [];

    await probeWith(receiverCheck({ addSecret: (value) => {
      added.push(value);
    },
    probe: async () => {
      expect(added).toEqual(['http://127.0.0.1:1', '127.0.0.1:1', '127.0.0.1']);

      return Promise.resolve();
    } }));
    expect(added).toHaveLength(3);
  });
});
