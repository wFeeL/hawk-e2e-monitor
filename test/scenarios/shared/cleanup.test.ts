import { runStage } from '../../../src/engine/stages.js';
import { describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/time/clock.js';
import { collectorAcceptStage, eventVisibleStage } from '../../../src/scenarios/shared/delivery.js';
import { cleanupStage } from '../../../src/scenarios/shared/cleanup.js';
import type { ScenarioContext } from '../../../src/scenarios/shared/context.js';
import { TIMEOUT_MS, run, scenario, useStageHarness } from '../../support/stage-harness.js';

useStageHarness();

describe('cleanupStage pause', () => {
  it('skips the recheck when the pause is cut by the timeout, and still tries to remove', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const slow: ScenarioContext = { ...context,
      config: { ...context.config,
        lateDuplicateWaitMs: 5000 } };
    const result = await runStage(cleanupStage(100), slow, { clock: systemClock,
      runSignal: new AbortController().signal });

    expect(result.details).toMatchObject({ recheck: 'skipped' });
    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_failed' });
  });
});
