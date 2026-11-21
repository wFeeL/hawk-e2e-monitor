import type { StageResult } from '../../../src/engine/result.js';
import { runStage } from '../../../src/engine/stages.js';
import { describe, expect, it, vi } from 'vitest';
import type { Clock } from '../../../src/time/clock.js';
import { systemClock } from '../../../src/time/clock.js';
import { createFakeClock } from '../../support/fake-clock.js';
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

describe('cleanupStage when the event is gone', () => {
  it('ends ok with a warning when the recheck finds the event missing', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const quick: ScenarioContext = { ...context,
      config: { ...context.config,
        lateDuplicateWaitMs: 0 } };

    const { event } = context.state;

    if (event === undefined) {
      throw new Error('The event stage left no event');
    }

    await context.api.removeEvent(context.config.hawk.projectId, event.originalEventId, new AbortController().signal);

    const result = await run(cleanupStage(TIMEOUT_MS), quick);

    expect(result).toMatchObject({ status: 'ok',
      details: { recheck: 'missing',
        warning: 'event was already gone before cleanup' } });
  });
});

/** What a cleanup run left behind. */
interface CleanupRun {
  /** Lengths of the pauses the stage asked the clock for. */
  pauses: number[];
  /** Status the stage ended with. */
  status: string;
}

/**
 * Builds a recorded stage.
 * @param status How it ended.
 * @returns Result of the stage `event_visible`.
 */
function stageResult(status: StageResult['status']): StageResult {
  return { name: 'event_visible',
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1 };
}

describe('cleanupStage after a failed stage', () => {
  /**
   * Runs the cleanup with a stage list and records the pauses it asks the clock for.
   * @param earlier Stages recorded before the cleanup.
   * @returns Lengths of the pauses and the cleanup outcome.
   */
  async function cleanupAfter(earlier: StageResult[]): Promise<CleanupRun> {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const fake = createFakeClock();
    const pauses: number[] = [];
    const clock: Clock = { ...fake,
      sleep: async (ms, signal) => {
        if (ms === 5000) {
          pauses.push(ms);

          return Promise.resolve();
        }

        return fake.sleep(ms, signal);
      } };
    const slow: ScenarioContext = { ...context,
      clock,
      config: { ...context.config,
        lateDuplicateWaitMs: 5000 } };
    const outcome = await cleanupStage(TIMEOUT_MS).run(slow, new AbortController().signal, earlier);

    return { pauses,
      status: outcome.status };
  }

  it('skips the pause before the recheck when a stage failed', async () => {
    const { pauses, status } = await cleanupAfter([stageResult('failed')]);

    expect(pauses).toEqual([]);
    expect(status).toBe('ok');
  });

  it('keeps the pause when every stage passed', async () => {
    const { pauses } = await cleanupAfter([stageResult('ok')]);

    expect(pauses).toEqual([5000]);
  });
});
