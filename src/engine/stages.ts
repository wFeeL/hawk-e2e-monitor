import { CheckError } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import type { StageDetails, StageName, StageResult, StageStatus } from './result.js';

/** What a stage body reports. */
export interface StageOutcome {
  /** How the stage ended. */
  status: StageStatus;
  /** Reason of a failure, or of the uncertainty. */
  error?: CheckError;
  /** Stage-specific data. */
  details?: StageDetails;
}

/** A stage: name, time limit and body. */
export interface StageSpec<C> {
  /** Stage name. */
  name: StageName;
  /** Time the body may take before its signal aborts. */
  timeoutMs: number;
  /** Body; must stop when the signal aborts. The runner of a scenario passes the stages recorded so far to a stage that needs them, such as the cleanup. */
  run: (context: C, signal: AbortSignal, earlier?: readonly StageResult[]) => Promise<StageOutcome>;
}

/** Clock and run-wide deadline of the stage runner. */
export interface StageRunnerOptions {
  /** Clock for timeouts and durations. */
  clock: Clock;
  /** Aborts every stage when the whole run is out of time. */
  runSignal: AbortSignal;
  /** Wait after an abort before a silent stage is given up on; 1000 by default. */
  graceMs?: number;
}

/** Reason that tells a stage the run was cancelled from outside, not that its deadline passed. */
export const RUN_CANCELLED = 'run cancelled';

type AbortReason = 'timeout' | 'run';
/** The body returned. */
interface Returned {
  /** Discriminator. */
  done: true;
  /** What the body returned. */
  outcome: StageOutcome;
}

/** The body threw. */
interface Thrown {
  /** Discriminator. */
  done: false;
  /** What the body threw. */
  error: unknown;
}

type Settled = Returned | Thrown;

const DEFAULT_GRACE_MS = 1000;

/**
 * Turns an unknown thrown value into text.
 * @param error Anything thrown.
 * @returns Message of an `Error`, a string itself, otherwise JSON, then `String(error)`, then a fixed text when nothing can print it.
 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  // A cyclic object or a BigInt breaks JSON.stringify, and an object without a prototype breaks String; the stage must still end.
  try {
    return JSON.stringify(error) ?? 'unknown error';
  } catch {
    try {
      return String(error);
    } catch {
      return 'unprintable error';
    }
  }
}

/**
 * Starts the body without letting a synchronous throw or a late rejection escape.
 * @param run Stage body call.
 * @returns Promise that always fulfils with the settled state.
 */
function settle(run: () => Promise<StageOutcome>): Promise<Settled> {
  try {
    return run().then(
      (outcome): Settled => ({ done: true,
        outcome }),
      (error: unknown): Settled => ({ done: false,
        error })
    );
  } catch (error) {
    return Promise.resolve({ done: false,
      error });
  }
}

/**
 * Builds the stage result from the body's end state.
 * @param name Which stage was skipped.
 * @param settled How the body ended, or `undefined` when it never did.
 * @param reason What aborted the stage, if anything.
 * @param cancelled Whether the run was cancelled from outside.
 * @returns Status and error without timing fields.
 */
function toOutcome(name: StageName, settled: Settled | undefined, reason: AbortReason | undefined, cancelled: boolean): StageOutcome {
  const runTimeout = (): CheckError => new CheckError('run_timeout', cancelled
    ? { stage: name,
        detail: 'cancelled' }
    : { stage: name });

  if (settled === undefined) {
    return { status: 'failed',
      error: reason === 'run'
        ? runTimeout()
        : new CheckError('monitor_internal', { stage: name,
          detail: 'stage did not finish after its deadline' }) };
  }

  if (!settled.done) {
    // After the run deadline a thrown failure is mostly the abort itself, so it must not blame Hawk.
    if (reason === 'run') {
      return { status: 'failed',
        error: runTimeout() };
    }

    return { status: 'failed',
      error: settled.error instanceof CheckError
        ? settled.error
        : new CheckError('monitor_internal', { stage: name,
          cause: describeThrown(settled.error) }) };
  }

  const { outcome } = settled;

  if (outcome.status === 'failed' && outcome.error === undefined) {
    return { ...outcome,
      error: new CheckError('monitor_internal', { stage: name,
        detail: 'stage failed without an error' }) };
  }

  if (reason === 'run' && (outcome.status === 'failed' || outcome.status === 'uncertain')) {
    return { ...outcome,
      error: runTimeout() };
  }

  return outcome;
}

/**
 * Runs one stage under its timeout and the run deadline.
 * @param spec Name, timeout and body of the stage.
 * @param context Shared state of the scenario, passed to the body untouched.
 * @param options Time source, run-wide deadline and the wait after an abort.
 * @returns Recorded result; never rejects.
 */
export async function runStage<C>(spec: StageSpec<C>, context: C, options: StageRunnerOptions): Promise<StageResult> {
  const { clock, runSignal } = options;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const startedAt = clock.wallTime().toISOString();
  const t0 = clock.monotonicMs();
  const stage = new AbortController();
  const timers = new AbortController();
  let reason: AbortReason | undefined;
  const abortWith = (why: AbortReason): void => {
    reason ??= why;
    stage.abort();
  };
  const onRunAbort = (): void => {
    abortWith('run');
  };
  const aborted = new Promise<undefined>((resolve) => {
    stage.signal.addEventListener('abort', () => {
      resolve(undefined);
    }, { once: true });
  });

  if (runSignal.aborted) {
    onRunAbort();
  } else {
    runSignal.addEventListener('abort', onRunAbort, { once: true });
  }

  clock.sleep(spec.timeoutMs, timers.signal).then(() => {
    abortWith('timeout');
  }, () => undefined);

  try {
    const body = settle(() => spec.run(context, stage.signal));
    let settled = await Promise.race([body, aborted]);

    if (settled === undefined) {
      settled = await Promise.race([
        body,
        clock.sleep(graceMs, timers.signal).then(() => undefined, () => undefined),
      ]);
    }

    const outcome = toOutcome(spec.name, settled, reason, runSignal.reason === RUN_CANCELLED);
    const result: StageResult = { name: spec.name,
      status: outcome.status,
      startedAt,
      durationMs: clock.monotonicMs() - t0 };

    if (outcome.error) {
      result.errorClass = outcome.error.errorClass;
      result.culprit = outcome.error.culprit;
      result.message = outcome.error.message;
    }

    if (outcome.details) {
      result.details = outcome.details;
    }

    return result;
  } finally {
    timers.abort();
    runSignal.removeEventListener('abort', onRunAbort);
  }
}

/**
 * Runs stages in parallel.
 * @param specs Name, timeout and body of each stage, in declared order.
 * @param context Shared state of the scenario, passed to every body untouched.
 * @param options Time source, run-wide deadline and the wait after an abort.
 * @returns Results in the declared order.
 */
export async function runStageGroup<C>(specs: readonly StageSpec<C>[], context: C, options: StageRunnerOptions): Promise<StageResult[]> {
  return Promise.all(specs.map(async spec => runStage(spec, context, options)));
}

/**
 * Records a stage that did not run.
 * @param name Which stage was skipped.
 * @param clock Source of the start timestamp.
 * @returns Skipped result with no duration.
 */
export function skippedStage(name: StageName, clock: Clock): StageResult {
  return { name,
    status: 'skipped',
    startedAt: clock.wallTime().toISOString(),
    durationMs: 0 };
}
