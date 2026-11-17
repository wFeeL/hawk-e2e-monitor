import { afterEach, beforeEach, vi } from 'vitest';
import { runStage } from '../../src/engine/stages.js';
import type { StageResult } from '../../src/engine/result.js';
import type { StageSpec } from '../../src/engine/stages.js';
import type { ScenarioContext } from '../../src/scenarios/shared/context.js';
import { systemClock } from '../../src/time/clock.js';
import { startFakeHawk } from './fake-hawk/index.js';
import type { FakeHawk } from './fake-hawk/index.js';
import { createTestScenario } from './scenario.js';
import type { TestScenarioOptions } from './scenario.js';

/** Time limit the stage tests give a stage that is not meant to time out. */
export const TIMEOUT_MS = 2000;

let current: FakeHawk | undefined;

/** What `useStageHarness` hands to a test file. */
export interface StageHarness {
  /**
   * Gives the fake Hawk of the running test.
   * @returns The server started by the hook before the test.
   */
  hawk(): FakeHawk;
}

/**
 * Starts a fake Hawk before every test of the file and closes it after.
 * @returns Accessor of the running fake.
 */
export function useStageHarness(): StageHarness {
  beforeEach(async () => {
    current = await startFakeHawk();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await current?.close();
  });

  return { hawk: () => {
    if (current === undefined) {
      throw new Error('The stage harness has no fake Hawk outside a test');
    }

    return current;
  } };
}

/**
 * Runs one stage under the engine, as the scenario does.
 * @param spec Stage to run.
 * @param context Scenario context.
 * @returns Recorded result.
 */
export async function run(spec: StageSpec<ScenarioContext>, context: ScenarioContext): Promise<StageResult> {
  return runStage(spec, context, { clock: systemClock,
    runSignal: new AbortController().signal });
}

/**
 * Builds a scenario context on the fake Hawk.
 * @param options Setup overrides.
 * @returns Context.
 */
export function scenario(options: TestScenarioOptions = {}): ReturnType<typeof createTestScenario> {
  const hawk = current;

  if (hawk === undefined) {
    throw new Error('The stage harness has no fake Hawk outside a test');
  }

  return createTestScenario(hawk, options);
}
