import { describe, expect, it } from 'vitest';
import type { StageName, StageResult, StageStatus } from '../../engine/result.js';
import type { ErrorClass } from '../../errors/taxonomy.js';
import { CULPRIT_OF } from '../../errors/taxonomy.js';
import { decideVerdict } from './verdict.js';

/** Optional parts of a stage result. */
interface StageExtra {
  /** Failure class. */
  errorClass?: ErrorClass;
  /** Text of the failure. */
  message?: string;
  /** Stage data. */
  details?: Record<string, unknown>;
}

const NAMES: StageName[] = ['collector_availability', 'api_availability', 'collector_accept', 'event_visible', 'event_repeated', 'cleanup'];

/**
 * Builds a stage result.
 * @param name Stage that ran.
 * @param status Outcome of the stage.
 * @param extra Optional class, text and details.
 * @returns Result with a fixed start and duration.
 */
function stage(name: StageName, status: StageStatus, extra: StageExtra = {}): StageResult {
  return { name,
    status,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    ...extra,
    ...extra.errorClass ? { culprit: CULPRIT_OF[extra.errorClass] } : {} };
}

/**
 * Builds results for all six stages, ok unless overridden.
 * @param overrides Results that replace the ok ones.
 * @returns Six results in order.
 */
function stages(...overrides: StageResult[]): StageResult[] {
  return NAMES.map(name => overrides.find(item => item.name === name) ?? stage(name, 'ok'));
}

describe('decideVerdict', () => {
  it('ok when nothing failed', () => {
    expect(decideVerdict(stages(), { sendMayHaveReached: false })).toEqual({ status: 'ok' });
  });

  it('ok when stage 3 is uncertain but the event appeared', () => {
    const verdict = decideVerdict(stages(stage('collector_accept', 'uncertain', { errorClass: 'collector_unavailable',
      message: 'cause' })), { sendMayHaveReached: true });

    expect(verdict.status).toBe('ok');
  });

  it('the first failed stage wins', () => {
    const verdict = decideVerdict(stages(
      stage('api_availability', 'failed', { errorClass: 'token_mismatch',
        message: 'wrong token' }),
      stage('event_visible', 'failed', { errorClass: 'event_mismatch' })
    ), { sendMayHaveReached: false });

    expect(verdict.failedStage).toBe('api_availability');
    expect(verdict.error?.errorClass).toBe('token_mismatch');
    expect(verdict.error?.culprit).toBe('config');
    expect(verdict.error?.message).toBe('wrong token');
  });

  it('a cleanup failure alone fails the run on cleanup', () => {
    const verdict = decideVerdict(stages(stage('cleanup', 'failed', { errorClass: 'cleanup_failed',
      message: 'not removed' })), { sendMayHaveReached: false });

    expect(verdict).toMatchObject({ status: 'failed',
      failedStage: 'cleanup' });
    expect(verdict.error?.errorClass).toBe('cleanup_failed');
  });

  it('a cleanup failure after another failure is not the verdict', () => {
    const verdict = decideVerdict(stages(
      stage('event_visible', 'failed', { errorClass: 'event_mismatch',
        message: 'differs' }),
      stage('cleanup', 'failed', { errorClass: 'cleanup_failed' })
    ), { sendMayHaveReached: false });

    expect(verdict.failedStage).toBe('event_visible');
  });

  it('uncertain accept plus event_not_found blames the collector and names both facts', () => {
    const verdict = decideVerdict(stages(
      stage('collector_accept', 'uncertain', { errorClass: 'collector_unavailable',
        message: 'Collector http://x/ did not respond: HTTP 503' }),
      stage('event_visible', 'failed', { errorClass: 'event_not_found',
        message: 'Event did not appear',
        details: { pollOutcome: 'not_found',
          waitedMs: 1234 } })
    ), { sendMayHaveReached: true });

    expect(verdict.failedStage).toBe('collector_accept');
    expect(verdict.error?.errorClass).toBe('collector_unavailable');
    expect(verdict.error?.culprit).toBe('hawk');
    expect(verdict.error?.message).toBe('Collector did not confirm the event (Collector http://x/ did not respond: HTTP 503); the event did not appear within 1234 ms');
  });

  it('uncertain accept plus an API failure keeps the API class and says the collector did not confirm either', () => {
    const verdict = decideVerdict(stages(
      stage('collector_accept', 'uncertain', { errorClass: 'collector_unavailable',
        message: 'cause' }),
      stage('event_visible', 'failed', { errorClass: 'api_unavailable',
        message: 'API did not respond',
        details: { pollOutcome: 'api_error' } })
    ), { sendMayHaveReached: true });

    expect(verdict.failedStage).toBe('event_visible');
    expect(verdict.error?.errorClass).toBe('api_unavailable');
    expect(verdict.error?.message).toBe('API did not respond; the event was not confirmed by the collector either');
  });

  it('a plain API failure gets no suffix when the accept was confirmed', () => {
    const verdict = decideVerdict(stages(
      stage('event_visible', 'failed', { errorClass: 'api_unavailable',
        message: 'API did not respond',
        details: { pollOutcome: 'api_error' } })
    ), { sendMayHaveReached: false });

    expect(verdict.error?.message).toBe('API did not respond');
  });

  it('a late duplicate after a run without a repeat fails event_visible', () => {
    const verdict = decideVerdict(stages(stage('event_repeated', 'skipped'), stage('cleanup', 'ok', { details: { lateTotalCount: 2 } })), { sendMayHaveReached: false });

    expect(verdict).toMatchObject({ status: 'failed',
      failedStage: 'event_visible' });
    expect(verdict.error?.errorClass).toBe('duplicate_event');
    expect(verdict.error?.culprit).toBe('hawk');
    expect(verdict.error?.message).toBe('The event count grew to 2 after the check, expected 1');
  });

  it('a late duplicate after a repeat fails event_repeated', () => {
    const verdict = decideVerdict(stages(stage('cleanup', 'ok', { details: { lateTotalCount: 3 } })), { sendMayHaveReached: false });

    expect(verdict.failedStage).toBe('event_repeated');
    expect(verdict.error?.message).toBe('The event count grew to 3 after the check, expected 2');
  });

  it('an earlier failure outranks a late duplicate', () => {
    const verdict = decideVerdict(stages(
      stage('event_repeated', 'failed', { errorClass: 'repeat_not_counted',
        message: 'not counted' }),
      stage('cleanup', 'ok', { details: { lateTotalCount: 3 } })
    ), { sendMayHaveReached: false });

    expect(verdict.failedStage).toBe('event_repeated');
    expect(verdict.error?.errorClass).toBe('repeat_not_counted');
  });

  it('a late duplicate outranks a cleanup failure', () => {
    const verdict = decideVerdict(stages(stage('event_repeated', 'skipped'), stage('cleanup', 'failed', { errorClass: 'cleanup_failed',
      details: { lateTotalCount: 2 } })), { sendMayHaveReached: false });

    expect(verdict.failedStage).toBe('event_visible');
    expect(verdict.error?.errorClass).toBe('duplicate_event');
  });
});
