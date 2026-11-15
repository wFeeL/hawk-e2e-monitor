import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, StageResult } from '../../../src/engine/result.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { encodeToken, startFakeHawk } from '../../support/fake-hawk/index.js';
import type { CollectorReplyOverride, FakeHawk } from '../../support/fake-hawk/index.js';
import type { EventCard, HawkApi } from '../../../src/clients/hawk-api.js';
import { TIMEOUT_LIMITS, createTestDeps } from '../../support/scenario.js';
import type { TestDepsOptions } from '../../support/scenario.js';
import { systemClock } from '../../../src/time/clock.js';
import { runSendAndReceive } from '../../../src/scenarios/send-and-receive/run.js';
import type { ScenarioDeps } from '../../../src/scenarios/send-and-receive/run.js';
import type { PlanOptions } from '../../../src/scenarios/send-and-receive/plan.js';

const LATE_EVENT_WARNING = 'The event appeared only after the event_visible deadline and was removed by cleanup';
const SECOND_SUBMISSION = 2;
const THIRD_SUBMISSION = 3;
const QUOTA_REFUSAL: CollectorReplyOverride = { status: 402,
  body: JSON.stringify({ code: 402,
    error: true,
    message: 'Project has exceeded the events limit' }) };
const RATE_LIMITED: CollectorReplyOverride = { status: 402,
  body: JSON.stringify({ code: 402,
    error: true,
    message: 'Rate limit exceeded' }) };

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Runs the scenario on the fake Hawk.
 * @param plan Run number and overrides.
 * @param setup Environment and clock overrides.
 * @param overrides Dependencies that replace the built ones.
 * @returns Result of the run.
 */
async function run(plan: PlanOptions = { sequence: 1 }, setup: TestDepsOptions = {}, overrides: Partial<ScenarioDeps> = {}): Promise<RunResult> {
  const { deps } = createTestDeps(hawk, setup);

  return runSendAndReceive({ ...deps,
    ...overrides }, plan);
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
    throw new Error(`No stage ${name}`);
  }

  return found;
}

/**
 * Wraps the API so that the card read of the cleanup recheck runs a hook first.
 * Card reads are told apart by their signal: each stage uses one, so the Nth distinct signal is the Nth stage that reads cards.
 * @param api API client to wrap.
 * @param ordinal Which distinct signal is the cleanup's: 2 without a repeat, 3 with one.
 * @param hook Runs before the read; returning a value replaces the answer, returning nothing lets the read go through.
 * @returns Wrapped client.
 */
function hookCleanupCard(api: HawkApi, ordinal: number, hook: () => EventCard | null | undefined): HawkApi {
  const signals = new Set<AbortSignal>();

  return { ...api,
    eventCard: async (projectId, eventId, signal) => {
      signals.add(signal);

      if (signals.size === ordinal) {
        const replaced = hook();

        if (replaced !== undefined) {
          return replaced;
        }
      }

      return api.eventCard(projectId, eventId, signal);
    } };
}

/** Puts a second copy of the stored event into the fake Hawk, as a worker finishing late would. */
function ingestLateDuplicate(): void {
  const [event] = hawk.store.all(hawk.projectId);

  if (event === undefined) {
    throw new Error('No event to duplicate');
  }

  hawk.store.ingest(hawk.projectId, event.catcherType, structuredClone(event.payload));
}

/**
 * Makes the first event send (the probe takes number 1) answer with the given reply.
 * @param reply Canned answer.
 * @param submission Number of the submission to replace.
 */
function replyAt(reply: CollectorReplyOverride, submission: number): void {
  hawk.collector.knobs.reply = number => number === submission ? reply : undefined;
}

describe('healthy fake', () => {
  it('is ok, records every stage with a duration and removes the event', async () => {
    const result = await run();

    expect(result.status).toBe('ok');
    expect(result.failedStage).toBeUndefined();
    expect(result.stages.map(stage => `${stage.name}:${stage.status}`)).toEqual([
      'collector_availability:ok',
      'api_availability:ok',
      'collector_accept:ok',
      'event_visible:ok',
      'event_repeated:skipped',
      'cleanup:ok',
    ]);
    expect(result.stages.filter(stage => stage.status === 'ok').every(stage => stage.durationMs > 0)).toBe(true);
    expect(result.event).toMatchObject({ totalCount: 1 });
    expect(result.cleanup).toEqual({ status: 'ok' });
    expect(stageOf(result, 'cleanup').details).toBeUndefined();
    expect(result.sendMayHaveReached).toBe(false);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('eventLatencyMs is measured from the accept and fits into the run', async () => {
    const result = await run();

    // The latency starts at the end of collector_accept, so it also holds the gap before event_visible starts; only the run bounds it.
    expect(result.eventLatencyMs).toBeTypeOf('number');
    expect(result.eventLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.eventLatencyMs).toBeLessThanOrEqual(result.durationMs);
  });

  it('describes the run: ids, title, transport and timestamps', async () => {
    const result = await run({ sequence: 1 });

    expect(result).toMatchObject({ scenario: 'send-and-receive-event',
      instanceId: 'fake',
      sequence: 1,
      transport: 'http',
      catcherType: 'errors/nodejs',
      warnings: [] });
    expect(result.runId).toMatch(/^r[a-z]{15}$/u);
    expect(result.title).toBe(`[e2e:fake] ${result.runId} send-and-receive-event`);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it('result JSON contains no password or token', async () => {
    const result = await run();
    const text = JSON.stringify(result);

    expect(text).not.toContain(hawk.password);
    expect(text).not.toContain(hawk.token);
    expect(text).not.toContain(Buffer.from(hawk.token, 'base64').toString('utf8'));
  });

  it('logs the finished run', async () => {
    const { deps, logger } = createTestDeps(hawk);
    const result = await runSendAndReceive(deps, { sequence: 1 });

    expect(logger.lines).toContainEqual(expect.objectContaining({ level: 'info',
      msg: 'run finished',
      runId: result.runId,
      status: 'ok' }));
  });

  it('puts the quota warning into warnings', async () => {
    hawk.api.knobs.workspace = { isBlocked: false,
      eventsLimit: 100,
      billingPeriodEventsCount: 95 };

    const result = await run();

    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual(['Event quota is almost used: 95/100']);
  });
});

describe('failures', () => {
  it('lost events: event_visible fails with event_not_found and the text says the API answered', async () => {
    hawk.collector.knobs.dropEvents = true;

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found',
      culprit: 'hawk' });
    expect(result.message).toMatch(/API answered \d+ times/u);
    // Cleanup searches after an accepted send, finds nothing and has nothing to remove.
    expect(result.cleanup.status).toBe('skipped');
    expect(stageOf(result, 'cleanup')).toMatchObject({ status: 'skipped',
      details: { found: false } });
    expect(hawk.api.removeCalls).toBe(0);
  });

  it('an accepted event that shows up only after stage 4 is found and removed by cleanup', async () => {
    hawk.collector.knobs.processingDelayMs = 600;

    const { deps } = createTestDeps(hawk, { env: { ...TIMEOUT_LIMITS,
      EVENT_VISIBLE_TIMEOUT_MS: '200',
      CLEANUP_TIMEOUT_MS: '1500' } });
    let stageSignal: AbortSignal | undefined;
    const waitingFind: ScenarioDeps['api'] = { ...deps.api,
      findEvents: async (projectId, search, signal) => {
        // The first search is stage 4; a search with another signal is the cleanup's, which waits for the delayed event.
        stageSignal ??= signal;

        if (signal !== stageSignal) {
          while (hawk.store.all(hawk.projectId).length === 0) {
            await systemClock.sleep(10, signal);
          }
        }

        return deps.api.findEvents(projectId, search, signal);
      } };
    const result = await runSendAndReceive({ ...deps,
      api: waitingFind }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found' });
    expect(stageOf(result, 'collector_accept').status).toBe('ok');
    expect(result.sendMayHaveReached).toBe(false);
    expect(result.cleanup.status).toBe('ok');
    expect(stageOf(result, 'cleanup').details).toMatchObject({ foundBySearch: true,
      originalEventId: expect.any(String) as string });
    expect(result.warnings).toEqual([LATE_EVENT_WARNING]);
    expect(hawk.api.removeCalls).toBe(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('API down: api_availability, api_unavailable, no POST reached the fake', async () => {
    hawk.api.knobs.down = true;

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'api_availability',
      errorClass: 'api_unavailable' });
    expect(hawk.collector.posts).toBe(0);
    expect(result.stages.slice(2, 5).map(stage => stage.status)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(result.cleanup.status).toBe('skipped');
  });

  it('collector health failure skips stages 2-5', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'collector_availability',
      errorClass: 'collector_dependency_error' });
    expect(result.stages.slice(1, 5).every(stage => stage.status === 'skipped')).toBe(true);
  });

  it('a blacklisted monitor IP: collector_availability, ip_blacklisted, culprit monitor, no POST', async () => {
    hawk.collector.knobs.blacklisted = true;

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_availability',
      errorClass: 'ip_blacklisted',
      culprit: 'monitor' });
    expect(hawk.collector.posts).toBe(0);
    expect(result.stages.slice(1, 5).every(stage => stage.status === 'skipped')).toBe(true);
  });

  it('402 quota: quota_exhausted with the monitor as culprit', async () => {
    replyAt(QUOTA_REFUSAL, SECOND_SUBMISSION);

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_accept',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(result.stages.slice(3, 5).every(stage => stage.status === 'skipped')).toBe(true);
    expect(result.sendMayHaveReached).toBe(false);
  });

  it('reply timeout with the event delivered: collector_accept uncertain, run ok, exactly one POST', async () => {
    hawk.collector.knobs.replyDelayMs = 300;

    const result = await run({ sequence: 1 }, { env: TIMEOUT_LIMITS });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'collector_accept')).toMatchObject({ status: 'uncertain',
      errorClass: 'collector_unavailable' });
    expect(result.sendMayHaveReached).toBe(true);
    expect(result.warnings).toEqual([expect.stringContaining('did not confirm the event')]);
    expect(result.warnings[0]).toContain('SDKs of users may see an error');
    expect(hawk.collector.posts).toBe(1);
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('a repeat answered too late: the run is ok and the repeat is marked uncertain with a warning', async () => {
    const { deps } = createTestDeps(hawk, { env: TIMEOUT_LIMITS });
    let sends = 0;
    const slowSecond: ScenarioDeps['collector'] = { ...deps.collector,
      send: async (...args) => {
        sends += 1;
        hawk.collector.knobs.replyDelayMs = sends === 2 ? 300 : 0;

        return deps.collector.send(...args);
      } };
    const result = await runSendAndReceive({ ...deps,
      collector: slowSecond }, { sequence: 1,
      repeat: true });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'collector_accept').status).toBe('ok');
    expect(stageOf(result, 'event_repeated')).toMatchObject({ status: 'ok',
      details: { repeatUncertain: true } });
    expect(result.warnings).toEqual([expect.stringContaining('did not confirm the repeated event')]);
    expect(result.warnings[0]).toContain('SDKs of users may see an error');
  });

  it('failure after send (a): a mangled title is a mismatch and cleanup removes the event', async () => {
    hawk.collector.knobs.mutatePayload = payload => ({ ...payload,
      title: 'mangled title' });

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_mismatch' });
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.api.removeCalls).toBe(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('failure after send (b): the event shows up only after stage 4, cleanup finds and removes it', async () => {
    hawk.collector.knobs.replyAfterAccept = { status: 503,
      body: 'Service Unavailable' };
    hawk.collector.knobs.processingDelayMs = 600;

    const { deps } = createTestDeps(hawk, { env: { ...TIMEOUT_LIMITS,
      EVENT_VISIBLE_TIMEOUT_MS: '200',
      CLEANUP_TIMEOUT_MS: '1500' } });
    let stageSignal: AbortSignal | undefined;
    const waitingFind: ScenarioDeps['api'] = { ...deps.api,
      findEvents: async (projectId, search, signal) => {
        // The first search is stage 4; a search with another signal is the cleanup's, which waits for the delayed event.
        stageSignal ??= signal;

        if (signal !== stageSignal) {
          while (hawk.store.all(hawk.projectId).length === 0) {
            await systemClock.sleep(10, signal);
          }
        }

        return deps.api.findEvents(projectId, search, signal);
      } };
    const result = await runSendAndReceive({ ...deps,
      api: waitingFind }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_accept',
      errorClass: 'collector_unavailable' });
    expect(stageOf(result, 'event_visible').errorClass).toBe('event_not_found');
    expect(result.cleanup.status).toBe('ok');
    expect(stageOf(result, 'cleanup').details).toMatchObject({ foundBySearch: true,
      originalEventId: expect.any(String) as string });
    expect(result.warnings).toEqual([expect.stringContaining('did not confirm the event'), LATE_EVENT_WARNING]);
    expect(hawk.api.removeCalls).toBe(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('a mangled field: event_mismatch names the field', async () => {
    hawk.collector.knobs.mutatePayload = payload => ({ ...payload,
      context: { ...(payload.context as Record<string, unknown>),
        instanceId: 'someone-else' } });

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'event_visible',
      errorClass: 'event_mismatch' });
    expect(result.message).toContain('context.instanceId');
  });

  it('a duplicate: duplicate_event', async () => {
    hawk.collector.knobs.duplicateOnAccept = true;

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'event_visible',
      errorClass: 'duplicate_event',
      culprit: 'hawk' });
    expect(result.cleanup.status).toBe('ok');
  });

  it('the repeat is not counted by the fake: repeat_not_counted', async () => {
    hawk.collector.knobs.dropEvents = number => number === THIRD_SUBMISSION;

    const result = await run({ sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_repeated',
      errorClass: 'repeat_not_counted' });
    expect(result.cleanup.status).toBe('ok');
  });

  it('503 at stage 3 and no event: collector_accept, collector_unavailable, text names both facts', async () => {
    replyAt({ status: 503,
      body: 'Service Unavailable' }, SECOND_SUBMISSION);

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_accept',
      errorClass: 'collector_unavailable',
      culprit: 'hawk' });
    expect(result.message).toContain('did not confirm the event');
    expect(result.message).toContain('did not appear within');
    expect(result.message).toContain('503');
  });

  it('402 Rate limit exceeded on the second send: event_repeated, rate_limited', async () => {
    replyAt(RATE_LIMITED, THIRD_SUBMISSION);

    const result = await run({ sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ failedStage: 'event_repeated',
      errorClass: 'rate_limited',
      culprit: 'monitor' });
  });

  it('a mangled title with a right context: cleanup removes the event', async () => {
    hawk.collector.knobs.mutatePayload = payload => ({ ...payload,
      title: 'something else entirely' });

    const result = await run();

    expect(result.failedStage).toBe('event_visible');
    expect(result.cleanup).toEqual({ status: 'ok' });
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('another project token: token_mismatch and no POST', async () => {
    hawk.api.knobs.projectToken = encodeToken('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'api_availability',
      errorClass: 'token_mismatch',
      culprit: 'config' });
    expect(hawk.collector.posts).toBe(0);
  });

  it('a foreign event at cleanup: cleanup_refused and removeEvent is not called', async () => {
    hawk.collector.knobs.dropEvents = true;
    hawk.collector.knobs.replyAfterAccept = { status: 503,
      body: 'Service Unavailable' };
    hawk.api.knobs.foreignEvent = true;

    const result = await run();

    expect(result.cleanup).toMatchObject({ status: 'refused',
      errorClass: 'cleanup_refused' });
    expect(hawk.api.removeCalls).toBe(0);
    expect(result.failedStage).toBe('collector_accept');
  });

  it('removeEvent answering false: cleanup_failed fails an otherwise good run on cleanup', async () => {
    hawk.api.knobs.rejectRemove = 'false';

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'cleanup',
      errorClass: 'cleanup_failed' });
    expect(result.cleanup).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_failed' });
  });

  it('a cleanup failure after another failure stays in the cleanup field', async () => {
    hawk.collector.knobs.duplicateOnAccept = true;
    hawk.api.knobs.rejectRemove = 'error';

    const result = await run();

    expect(result.failedStage).toBe('event_visible');
    expect(result.errorClass).toBe('duplicate_event');
    expect(result.cleanup).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_failed' });
  });

  it('the run deadline between stages: the next stage fails with run_timeout, the rest are skipped', async () => {
    const { deps } = createTestDeps(hawk);
    const slowCollector: ScenarioDeps['collector'] = { ...deps.collector,
      health: async () => systemClock.sleep(80),
      probeInvalidToken: async () => Promise.resolve() };
    const result = await runSendAndReceive({ ...deps,
      collector: slowCollector,
      config: { ...deps.config,
        timeouts: { ...deps.config.timeouts,
          run: 30 } } }, { sequence: 1 });

    expect(stageOf(result, 'api_availability')).toMatchObject({ status: 'failed',
      errorClass: 'run_timeout',
      message: expect.stringContaining('stage did not start before the run deadline') as string });
    expect(result.stages.slice(2, 5).every(stage => stage.status === 'skipped')).toBe(true);
    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'api_availability',
      errorClass: 'run_timeout' });
  });
});

describe('transport and repeat', () => {
  it('--transport ws goes through the WebSocket path', async () => {
    const result = await run({ sequence: 1,
      transport: 'ws' });

    expect(result).toMatchObject({ status: 'ok',
      transport: 'ws',
      catcherType: 'errors/javascript' });
    expect(hawk.collector.posts).toBe(0);
  });

  it('--repeat sends the event twice and counts it twice', async () => {
    const result = await run({ sequence: 1,
      repeat: true });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'event_repeated').status).toBe('ok');
    expect(result.event?.totalCount).toBe(2);
    expect(hawk.collector.posts).toBe(2);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('--repeat over WebSocket', async () => {
    const result = await run({ sequence: 2,
      transport: 'ws',
      repeat: true });

    expect(result.status).toBe('ok');
    expect(result.event?.totalCount).toBe(2);
  });

  it.each([
    [2, 'ws', 'skipped'],
    [3, 'http', 'ok'],
    [4, 'ws', 'ok'],
    [5, 'http', 'skipped'],
  ] as const)('alternate, N=2: run %i uses %s, event_repeated is %s', async (sequence, transport, repeated) => {
    const result = await run({ sequence }, { env: { REPEAT_EVERY_N_RUNS: '2' } });

    expect(result.status).toBe('ok');
    expect(result.transport).toBe(transport);
    expect(stageOf(result, 'event_repeated').status).toBe(repeated);
  });
});

describe('late duplicate', () => {
  it('without a repeat: event_visible, duplicate_event, and the event is still removed', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive({ ...deps,
      api: hookCleanupCard(deps.api, 2, () => {
        ingestLateDuplicate();

        return undefined;
      }) }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'duplicate_event',
      culprit: 'hawk',
      message: 'The event count grew to 2 after the check, expected 1' });
    expect(stageOf(result, 'event_visible').status).toBe('ok');
    expect(stageOf(result, 'cleanup').details).toMatchObject({ lateTotalCount: 2 });
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.api.removeCalls).toBe(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('the pause before the recheck is wide enough for a copy that arrives during it', async () => {
    const waitMs = 50;
    const { deps } = createTestDeps(hawk, { env: { LATE_DUPLICATE_WAIT_MS: String(waitMs) } });
    const pausing: ScenarioDeps['clock'] = { ...deps.clock,
      sleep: async (ms, signal) => {
        const slept = deps.clock.sleep(ms, signal);

        // The copy lands after the pause has started and before it ends.
        if (ms === waitMs) {
          ingestLateDuplicate();
        }

        return slept;
      } };
    const result = await runSendAndReceive({ ...deps,
      clock: pausing }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'duplicate_event' });
    expect(stageOf(result, 'cleanup').details).toMatchObject({ lateTotalCount: 2 });
  });

  it('after a repeat: event_repeated', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive({ ...deps,
      api: hookCleanupCard(deps.api, 3, () => {
        ingestLateDuplicate();

        return undefined;
      }) }, { sequence: 1,
      repeat: true });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_repeated',
      errorClass: 'duplicate_event',
      message: 'The event count grew to 3 after the check, expected 2' });
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('a recheck that fails does not fail the run', async () => {
    const { deps } = createTestDeps(hawk);
    const failure = new CheckError('api_unavailable', { code: 'TIMEOUT' });
    const result = await runSendAndReceive({ ...deps,
      api: hookCleanupCard(deps.api, 2, () => {
        throw failure;
      }) }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'cleanup')).toMatchObject({ status: 'ok',
      details: { recheck: 'failed' } });
    expect(result.warnings).toEqual([`The event count could not be rechecked before cleanup: ${failure.message}`]);
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('a recheck that hangs is cut after one http timeout and the event is still removed', async () => {
    const { deps } = createTestDeps(hawk);
    const signals = new Set<AbortSignal>();
    const hanging: HawkApi = { ...deps.api,
      eventCard: async (projectId, eventId, signal) => {
        signals.add(signal);

        // The second signal is the cleanup recheck's: the API hangs until that signal aborts.
        if (signals.size === 2) {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              resolve();
            }, { once: true });
          });

          throw new CheckError('api_unavailable', { code: 'TIMEOUT' });
        }

        return deps.api.eventCard(projectId, eventId, signal);
      } };
    const result = await runSendAndReceive({ ...deps,
      api: hanging }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'cleanup')).toMatchObject({ status: 'ok',
      details: { recheck: 'failed' } });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('could not be rechecked');
    expect(hawk.api.removeCalls).toBe(1);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('a recheck that finds no card does not fail the run', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive({ ...deps,
      api: hookCleanupCard(deps.api, 2, () => null) }, { sequence: 1 });

    expect(result.status).toBe('ok');
    expect(stageOf(result, 'cleanup').details).toMatchObject({ recheck: 'missing' });
    expect(result.warnings).toEqual([]);
    expect(hawk.api.removeCalls).toBe(1);
  });

  it('a wait cut by the cleanup limit skips the recheck and warns', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive({ ...deps,
      config: { ...deps.config,
        lateDuplicateWaitMs: 5000,
        timeouts: { ...deps.config.timeouts,
          cleanup: 100 } } }, { sequence: 1 });

    expect(stageOf(result, 'cleanup').details).toMatchObject({ recheck: 'skipped' });
    expect(result.warnings).toEqual(['The event count was not rechecked: the cleanup time limit cut the wait']);
  });

  it('a healthy recheck leaves no trace in the details', async () => {
    const result = await run();

    expect(stageOf(result, 'cleanup').details).toBeUndefined();
  });
});

describe('cancelling from outside', () => {
  /**
   * Wraps the API so the first search aborts the run and finds nothing, as if the caller cancelled mid-poll.
   * @param api Real client.
   * @param cancel Aborts the run.
   * @returns Client with the same calls.
   */
  function cancelOnFirstSearch(api: HawkApi, cancel: () => void): HawkApi {
    let first = true;

    return { ...api,
      findEvents: async (projectId, runId, signal) => {
        if (first) {
          first = false;
          cancel();

          return [];
        }

        return api.findEvents(projectId, runId, signal);
      } };
  }

  it('an abort in the middle of event_visible is run_timeout "the run was cancelled" and cleanup still runs', async () => {
    const { deps } = createTestDeps(hawk);
    const outside = new AbortController();
    const result = await runSendAndReceive({ ...deps,
      signal: outside.signal,
      api: cancelOnFirstSearch(deps.api, () => {
        outside.abort();
      }) }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'run_timeout',
      message: 'The run was cancelled' });
    expect(stageOf(result, 'event_repeated').status).toBe('skipped');
    expect(result.cleanup.status).toBe('ok');
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('a signal that is already aborted fails the first stage and still runs cleanup', async () => {
    const { deps } = createTestDeps(hawk);
    const result = await runSendAndReceive({ ...deps,
      signal: AbortSignal.abort() }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_availability',
      errorClass: 'run_timeout',
      message: 'The run was cancelled' });
    expect(result.stages.slice(1, 5).every(stage => stage.status === 'skipped')).toBe(true);
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
  });
});
