import type { CleanupResult, RunResult, StageName, StageResult } from '../engine/result.js';
import { RUN_CANCELLED, runStage, runStageGroup, skippedStage } from '../engine/stages.js';
import type { StageSpec } from '../engine/stages.js';
import { redactDeep } from '../errors/redact.js';
import type { Redactor } from '../errors/redact.js';
import { CheckError } from '../errors/taxonomy.js';
import type { Logger } from '../log/logger.js';
import type { Clock } from '../time/clock.js';
import type { ScenarioName } from './names.js';
import type { RunPlan } from './shared/plan.js';
import type { ScenarioState } from './send-and-receive/stages.js';
import type { Verdict } from './shared/verdict.js';

/** What `runSteps` needs. */
export interface RunStepsOptions<C> {
  /** Shared state of the scenario, passed to every stage. */
  context: C;
  /** Time source and sleeper. */
  clock: Clock;
  /** Deadline of all steps together, cleanup excluded. */
  runTimeoutMs: number;
  /** Cancels the run from outside like its own deadline does. */
  signal?: AbortSignal;
  /** Steps in order; stages of one step run in parallel. */
  steps: ReadonlyArray<ReadonlyArray<StageSpec<C>>>;
  /** Cleanup, run after the steps with its own timeout outside the run deadline. */
  cleanup: StageSpec<C>;
  /** Tells whether the run goes on after the first stage of a step failed. */
  keepGoing?: (failed: StageResult) => boolean;
}

/** What `runSteps` recorded. */
export interface StepsOutcome {
  /** All stages in order, cleanup last. */
  stages: StageResult[];
  /** Wall-clock start, ISO. */
  startedAt: string;
  /** Monotonic start. */
  startedMs: number;
}

/**
 * Makes the run controller abort when the caller's signal does, with the reason that tells stages it was a cancellation.
 * @param run Controller whose signal the stages watch.
 * @param outside Signal of the caller, if any.
 * @returns Removes the listener.
 */
export function followOutsideSignal(run: AbortController, outside: AbortSignal | undefined): () => void {
  if (outside === undefined) {
    return () => undefined;
  }

  const cancel = (): void => {
    run.abort(RUN_CANCELLED);
  };

  if (outside.aborted) {
    cancel();

    return () => undefined;
  }

  outside.addEventListener('abort', cancel, { once: true });

  return () => {
    outside.removeEventListener('abort', cancel);
  };
}

/**
 * Records a stage that could not start because the run was already aborted.
 * @param name Stage that did not start.
 * @param clock Source of the start timestamp.
 * @param run Signal of the run; its reason tells a cancellation from a deadline.
 * @returns Failed result with `run_timeout`.
 */
export function abortedStage(name: StageName, clock: Clock, run: AbortSignal): StageResult {
  const cancelled = run.reason === RUN_CANCELLED;
  const error = cancelled
    ? new CheckError('run_timeout', { stage: name,
      detail: 'cancelled' })
    : new CheckError('run_timeout', { stage: name }, { message: 'stage did not start before the run deadline' });

  return { name,
    status: 'failed',
    startedAt: clock.wallTime().toISOString(),
    durationMs: 0,
    errorClass: error.errorClass,
    culprit: error.culprit,
    message: error.message };
}

/**
 * Maps the cleanup stage to the cleanup field of the result.
 * @param stage Recorded cleanup stage.
 * @returns Cleanup status; a refusal gets its own status, others carry class and text when failed.
 */
export function toCleanupResult(stage: StageResult): CleanupResult {
  if (stage.status === 'ok' || stage.status === 'skipped') {
    return { status: stage.status };
  }

  const result: CleanupResult = { status: stage.errorClass === 'cleanup_refused' ? 'refused' : 'failed' };

  if (stage.errorClass !== undefined) {
    result.errorClass = stage.errorClass;
  }

  if (stage.message !== undefined) {
    result.message = stage.message;
  }

  return result;
}

/**
 * Collects the warnings the stages wrote.
 * @param stages Recorded stages.
 * @returns Texts in stage order, a single `warning` before a `warnings` list.
 */
export function stageWarnings(stages: readonly StageResult[]): string[] {
  return stages.flatMap((stage) => {
    const { warning, warnings } = stage.details ?? {};

    return [
      ...typeof warning === 'string' ? [warning] : [],
      ...Array.isArray(warnings) ? warnings.filter((item): item is string => typeof item === 'string') : [],
    ];
  });
}

/**
 * Runs the steps of a scenario under one deadline, then its cleanup.
 * After a failed stage the later steps are recorded as skipped, unless `keepGoing` says otherwise.
 * @param options Context, clock, deadline, steps and cleanup.
 * @returns Every stage in order with the start times; never rejects for failures of stages.
 */
export async function runSteps<C>(options: RunStepsOptions<C>): Promise<StepsOutcome> {
  const { clock, context } = options;
  const startedAt = clock.wallTime().toISOString();
  const startedMs = clock.monotonicMs();
  const run = new AbortController();
  const timer = new AbortController();
  const unfollow = followOutsideSignal(run, options.signal);
  const stages: StageResult[] = [];

  clock.sleep(options.runTimeoutMs, timer.signal).then(() => {
    run.abort();
  }, () => undefined);

  try {
    let skipRest = false;

    for (const step of options.steps) {
      if (skipRest) {
        stages.push(...step.map(spec => skippedStage(spec.name, clock)));
      } else if (run.signal.aborted) {
        stages.push(...step.map(spec => abortedStage(spec.name, clock, run.signal)));
        skipRest = true;
      } else {
        const runner = { clock,
          runSignal: run.signal };
        const results = step.length === 1 && step[0] !== undefined
          ? [await runStage(step[0], context, runner)]
          : await runStageGroup(step, context, runner);
        const [first] = results;

        stages.push(...results);
        skipRest = first?.status === 'failed' && options.keepGoing?.(first) !== true;
      }
    }
  } finally {
    timer.abort();
    unfollow();
  }

  // Cleanup has its own timeout outside the run deadline, so its signal is never aborted by the run.
  stages.push(await runStage(options.cleanup, context, { clock,
    runSignal: new AbortController().signal }));

  return { stages,
    startedAt,
    startedMs };
}

/** What `buildRunResult` needs. */
export interface ResultInput {
  /** Scenario that ran. */
  scenario: ScenarioName;
  /** Decisions made before the run. */
  plan: RunPlan;
  /** Id of this monitor. */
  instanceId: string;
  /** What `runSteps` recorded. */
  outcome: StepsOutcome;
  /** Time source. */
  clock: Clock;
  /** Pass or fail with the stage and error to blame. */
  verdict: Verdict;
  /** Non-fatal remarks. */
  warnings: string[];
  /** State the stages left. */
  state: ScenarioState;
  /** Masks secrets in the whole result. */
  redact: Redactor;
  /** Logger of the run. */
  logger: Logger;
  /** Fields a scenario adds before masking. */
  extra?: Partial<RunResult>;
}

/**
 * Assembles the result of a run, masks secrets and logs the end.
 * @param input Plan, stages, verdict and state of the run.
 * @returns The result with secrets masked.
 */
export function buildRunResult(input: ResultInput): RunResult {
  const { plan, state, verdict, clock, outcome } = input;
  const cleanupStageResult = outcome.stages.at(-1);
  const result: RunResult = {
    runId: plan.runId,
    scenario: input.scenario,
    instanceId: input.instanceId,
    sequence: plan.sequence,
    transport: plan.transport,
    catcherType: plan.catcherType,
    title: plan.title,
    startedAt: outcome.startedAt,
    finishedAt: clock.wallTime().toISOString(),
    durationMs: clock.monotonicMs() - outcome.startedMs,
    status: verdict.status,
    warnings: input.warnings,
    sendMayHaveReached: state.sendMayHaveReached,
    stages: outcome.stages,
    cleanup: cleanupStageResult ? toCleanupResult(cleanupStageResult) : { status: 'skipped' },
  };

  if (verdict.failedStage) {
    result.failedStage = verdict.failedStage;
  }

  if (verdict.error) {
    result.errorClass = verdict.error.errorClass;
    result.culprit = verdict.error.culprit;
    result.message = verdict.error.message;
  }

  if (state.event) {
    result.event = { originalEventId: state.event.originalEventId,
      groupHash: state.event.groupHash,
      totalCount: state.event.totalCount };
  }

  if (state.latencyMs !== undefined) {
    result.eventLatencyMs = state.latencyMs;
  }

  Object.assign(result, input.extra);

  const redacted = redactDeep(result, input.redact);

  input.logger.info('run finished', { runId: redacted.runId,
    status: redacted.status,
    failedStage: redacted.failedStage });

  return redacted;
}
