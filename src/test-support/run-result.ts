import type { RunResult, StageName, StageResult, StageStatus } from '../engine/result.js';

const FIXTURE_START = '2026-03-10T10:00:00.000Z';
const FIXTURE_END = '2026-03-10T10:00:05.000Z';
const FIXTURE_STAGE_MS = 100;
const FIXTURE_DURATION_MS = 5000;
const DEFAULT_STAGES: readonly StageName[] = ['collector_availability', 'api_availability', 'collector_accept', 'event_visible', 'cleanup'];

/**
 * Builds a stage result for tests.
 * @param name Stage that ran.
 * @param status How the stage ended.
 * @param durationMs Monotonic time the stage took.
 * @param extra Fields that replace the defaults.
 * @returns Stage result.
 */
export function stageFixture(name: StageName, status: StageStatus = 'ok', durationMs = FIXTURE_STAGE_MS, extra: Partial<StageResult> = {}): StageResult {
  return { name,
    status,
    startedAt: FIXTURE_START,
    durationMs,
    ...extra };
}

/**
 * Builds a finished `ok` run result for tests.
 * @param overrides Fields that replace the defaults.
 * @returns Run result of `send-and-receive-event`.
 */
export function runResultFixture(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'raaaaaaaaaaaaaaaa',
    scenario: 'send-and-receive-event',
    instanceId: 'test',
    sequence: 1,
    transport: 'http',
    catcherType: 'errors/nodejs',
    title: '[e2e:test] raaaaaaaaaaaaaaaa send-and-receive-event',
    startedAt: FIXTURE_START,
    finishedAt: FIXTURE_END,
    durationMs: FIXTURE_DURATION_MS,
    status: 'ok',
    warnings: [],
    sendMayHaveReached: true,
    stages: DEFAULT_STAGES.map(name => stageFixture(name)),
    cleanup: { status: 'ok' },
    ...overrides,
  };
}
