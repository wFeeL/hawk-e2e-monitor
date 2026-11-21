import { runStage } from '../../../src/engine/stages.js';
import { describe, expect, it, vi } from 'vitest';
import { systemClock } from '../../../src/time/clock.js';
import { collectorAcceptStage, eventVisibleStage } from '../../../src/scenarios/shared/delivery.js';
import { cleanupStage } from '../../../src/scenarios/shared/cleanup.js';
import type { ScenarioContext } from '../../../src/scenarios/shared/context.js';
import { TIMEOUT_MS, run, scenario, useStageHarness } from '../../support/stage-harness.js';

useStageHarness();

describe('cleanupStage pause', () => {
  it('ends as monitor_internal when the pause is cut by the timeout, without a removal', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const slow: ScenarioContext = { ...context,
      config: { ...context.config,
        lateDuplicateWaitMs: 5000 } };
    const removeEvent = vi.spyOn(context.api, 'removeEvent');
    const result = await runStage(cleanupStage(100), slow, { clock: systemClock,
      runSignal: new AbortController().signal });

    expect(result.details).toMatchObject({ recheck: 'skipped' });
    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'monitor_internal',
      culprit: 'monitor' });
    expect(removeEvent).not.toHaveBeenCalled();
  });
});
