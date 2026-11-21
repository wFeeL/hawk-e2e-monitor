import { describe, expect, it } from 'vitest';
import type { StageName } from '../../src/engine/result.js';
import type { StageSpec } from '../../src/engine/stages.js';
import { CheckError } from '../../src/errors/taxonomy.js';
import { buildRunResult, runSteps } from '../../src/scenarios/run-steps.js';
import { planRun } from '../../src/scenarios/shared/plan.js';
import { systemClock } from '../../src/time/clock.js';
import { createFakeClock } from '../support/fake-clock.js';
import { testConfig } from '../support/config.js';
import { memoryLogger } from '../support/logger.js';

/** Context of the fake stages. */
interface Ctx {
  /** Names of the stages that ran, in order. */
  ran: string[];
}

/**
 * Builds a stage that records its run and ends as told.
 * @param name Which stage to build.
 * @param status Outcome the stage reports.
 * @returns Stage spec.
 */
function stage(name: StageName, status: 'failed' | 'ok' = 'ok'): StageSpec<Ctx> {
  return { name,
    timeoutMs: 1000,
    run: async (context) => {
      context.ran.push(name);

      return Promise.resolve(status === 'ok'
        ? { status }
        : { status,
            error: new CheckError('event_not_found') });
    } };
}

describe('runSteps', () => {
  it('runs the steps in order and cleanup last', async () => {
    const context: Ctx = { ran: [] };
    const outcome = await runSteps({ context,
      clock: systemClock,
      runTimeoutMs: 1000,
      steps: [[stage('collector_availability')], [stage('api_availability'), stage('collector_accept')]],
      cleanup: stage('cleanup') });

    expect(outcome.stages.map(item => item.name)).toEqual(['collector_availability', 'api_availability', 'collector_accept', 'cleanup']);
    expect(outcome.stages.every(item => item.status === 'ok')).toBe(true);
    expect(context.ran.at(-1)).toBe('cleanup');
    expect(outcome.startedAt).toMatch(/^\d{4}-/u);
  });

  it('skips the later steps after a failure and still cleans up', async () => {
    const context: Ctx = { ran: [] };
    const outcome = await runSteps({ context,
      clock: systemClock,
      runTimeoutMs: 1000,
      steps: [[stage('collector_availability', 'failed')], [stage('api_availability'), stage('collector_accept')]],
      cleanup: stage('cleanup') });

    expect(outcome.stages.map(item => item.status)).toEqual(['failed', 'skipped', 'skipped', 'ok']);
    expect(context.ran).toEqual(['collector_availability', 'cleanup']);
  });

  it('hands the stages recorded so far to the cleanup', async () => {
    const seen: string[] = [];
    const cleanup: StageSpec<Ctx> = { name: 'cleanup',
      timeoutMs: 1000,
      run: async (_context, _signal, earlier) => {
        seen.push(...(earlier ?? []).map(item => `${item.name}:${item.status}`));

        return Promise.resolve({ status: 'ok' });
      } };

    await runSteps({ context: { ran: [] },
      clock: systemClock,
      runTimeoutMs: 1000,
      steps: [[stage('collector_availability')], [stage('api_availability', 'failed')]],
      cleanup });

    expect(seen).toEqual(['collector_availability:ok', 'api_availability:failed']);
  });

  it('goes on after a failure that keepGoing accepts', async () => {
    const context: Ctx = { ran: [] };
    const outcome = await runSteps({ context,
      clock: systemClock,
      runTimeoutMs: 1000,
      steps: [[stage('collector_accept', 'failed')], [stage('event_visible')]],
      keepGoing: result => result.name === 'collector_accept',
      cleanup: stage('cleanup') });

    expect(outcome.stages.map(item => item.status)).toEqual(['failed', 'ok', 'ok']);
  });

  it('fails the steps that cannot start once the run deadline has passed', async () => {
    const clock = createFakeClock();
    const slow: StageSpec<Ctx> = { name: 'collector_availability',
      timeoutMs: 10_000,
      run: async (_context, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ status: 'ok' });
        });
      }) };
    const pending = runSteps({ context: { ran: [] },
      clock,
      runTimeoutMs: 100,
      steps: [[slow], [stage('api_availability')]],
      cleanup: stage('cleanup') });

    await clock.advance(100);

    const outcome = await pending;

    expect(outcome.stages.map(item => [item.name, item.status])).toEqual([['collector_availability', 'ok'], ['api_availability', 'failed'], ['cleanup', 'ok']]);
    expect(outcome.stages[1]?.errorClass).toBe('run_timeout');
  });

  it('cancels the run when the outside signal aborts and names the cancellation', async () => {
    const outside = new AbortController();
    const waiting: StageSpec<Ctx> = { name: 'collector_availability',
      timeoutMs: 10_000,
      run: async (_context, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ status: 'ok' });
        });
      }) };
    const pending = runSteps({ context: { ran: [] },
      clock: systemClock,
      runTimeoutMs: 10_000,
      signal: outside.signal,
      steps: [[waiting], [stage('api_availability')]],
      cleanup: stage('cleanup') });

    outside.abort();

    const outcome = await pending;

    expect(outcome.stages[1]?.message).toContain('cancelled');
    expect(outcome.stages.at(-1)).toMatchObject({ name: 'cleanup',
      status: 'ok' });
  });
});

describe('buildRunResult', () => {
  it('assembles the result, adds the event and masks secrets', () => {
    const config = testConfig();
    const plan = planRun(config, { sequence: 3 }, 'send-and-receive-event', () => 'a'.repeat(15));
    const logger = memoryLogger();
    const result = buildRunResult({ scenario: 'send-and-receive-event',
      plan,
      instanceId: config.instanceId,
      outcome: { stages: [{ name: 'cleanup',
        status: 'ok',
        startedAt: 'x',
        durationMs: 1 }],
      startedAt: 'start',
      startedMs: 0 },
      clock: createFakeClock({ monotonicMs: 50 }),
      verdict: { status: 'ok' },
      warnings: ['note secret-value'],
      state: { sendMayHaveReached: false,
        latencyMs: 12,
        event: { originalEventId: 'e1',
          groupHash: 'g',
          totalCount: 1,
          catcherType: 'errors/nodejs',
          title: 't',
          context: {} } },
      redact: text => text.replaceAll('secret-value', '***'),
      logger });

    expect(result).toMatchObject({ runId: plan.runId,
      scenario: 'send-and-receive-event',
      instanceId: config.instanceId,
      sequence: 3,
      status: 'ok',
      startedAt: 'start',
      durationMs: 50,
      eventLatencyMs: 12,
      warnings: ['note ***'],
      cleanup: { status: 'ok' },
      event: { originalEventId: 'e1',
        groupHash: 'g',
        totalCount: 1 } });
    expect(logger.lines.some(line => line.msg === 'run finished')).toBe(true);
  });

  it('records the failure of the verdict', () => {
    const config = testConfig();
    const plan = planRun(config, { sequence: 1 }, 'sourcemaps', () => 'a'.repeat(15));
    const result = buildRunResult({ scenario: 'sourcemaps',
      plan,
      instanceId: config.instanceId,
      outcome: { stages: [],
        startedAt: 's',
        startedMs: 0 },
      clock: createFakeClock(),
      verdict: { status: 'failed',
        failedStage: 'event_visible',
        error: new CheckError('event_not_found') },
      warnings: [],
      state: { sendMayHaveReached: false },
      redact: text => text,
      logger: memoryLogger() });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk',
      cleanup: { status: 'skipped' } });
  });
});
