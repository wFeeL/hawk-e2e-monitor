import type { Config } from '../config/load.js';
import { RULE_WARMUP_MARGIN_MS } from '../config/schema.js';
import { scenarioSettings } from '../config/scenario.js';
import type { ScenarioSettings } from '../config/scenario.js';
import type { RunResult } from '../engine/result.js';
import type { Redactor } from '../errors/redact.js';
import { CheckError } from '../errors/taxonomy.js';
import type { Logger } from '../log/logger.js';
import { createRunId } from '../scenarios/shared/plan.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { History } from '../storage/history.js';
import type { RunStart } from '../storage/types.js';
import { abortedOutcome, isMonitorAbort, isVerdict, outcomeOf, rowOf } from '../storage/outcome.js';
import type { VerdictFields } from '../storage/outcome.js';
import type { RunOutcome, RunRow, RunTrigger } from '../storage/types.js';
import type { Clock } from '../time/clock.js';

const SELF_CHECK_MS = 60_000;
const HUNGS_BEFORE_EXIT = 3;
const LAST_RUNS_LOOKED_AT = 5;

/** Rows of the history read to seed the warmup streak at start. */
const WARMUP_SEED_ROWS = 10;

/** Notification checks skipped for the rule cache warmup in a row that make the last of them a failure. */
export const WARMUP_SKIP_LIMIT = 3;

/**
 * Tells whether a run neither extends nor resets the warmup streak.
 * @param row Run to judge.
 * @returns True for an overlap skip and for a stop or restart of the monitor.
 */
const keepsStreak = (row: VerdictFields): boolean => (row.status === 'skipped' && row.skipReason === 'overlap') || isMonitorAbort(row);

/**
 * Tells whether a stored run counts toward the warmup streak.
 * @param row Run to judge.
 * @returns True for a warmup skip and for the failure that the scheduler made of one.
 */
const isWarmupRun = (row: RunRow): boolean => (row.status === 'skipped' && row.skipReason === 'rule_cache_warmup')
  || (row.status === 'failed' && row.errorClass === 'provisioning_unstable' && row.failedStage === 'notification_formed');

/** What a runner gets for one run. */
export interface ScenarioRunOptions {
  /** Id the scheduler made and recorded for the run. */
  runId: string;
  /** Number of the run within its scenario. */
  sequence: number;
  /** Aborts the run; the scheduler fires it when the run hangs or the monitor stops. */
  signal: AbortSignal;
}

/** Runs one scenario once. */
export type ScenarioRunner = (options: ScenarioRunOptions) => Promise<RunResult>;

/** Hears about every finished row. */
export type RunFinishedListener = (row: RunRow, result: RunResult | undefined) => void;

/** What the scheduler needs from outside. */
export interface SchedulerDeps {
  /** Runner of each scenario; only scenarios of the configuration that have a runner are scheduled. */
  runners: Partial<Record<ScenarioName, ScenarioRunner>>;
  /** Store of the runs. */
  history: History;
  /** Time source and sleeper. */
  clock: Clock;
  /** Log. */
  logger: Logger;
  /** Configuration with the timeouts and the `monitoring` settings. */
  config: Config;
  /** Masks secrets in the text of an exception of a scenario. */
  redact: Redactor;
  /** Makes run ids; `createRunId` by default. */
  newRunId?: () => string;
  /** Time between the starts of two runs of a scenario; the scenario's settings by default. */
  intervalOf?: (scenario: ScenarioName) => number;
  /** Waited before the first run of a scenario; a rejection is logged and ignored. */
  beforeFirstRun?: Partial<Record<ScenarioName, (signal: AbortSignal) => Promise<void>>>;
  /** Called after a row is finished, whatever its status; each listener has its own error handling. */
  onRunFinished?: RunFinishedListener | readonly RunFinishedListener[];
  /** Called with code 1 after three hung runs of one scenario in a row, or when a scenario stops ticking. */
  exit: (code: number) => void;
}

/** What the scheduler knows about a scenario. */
export interface SchedulerStatus {
  /** Scenario. */
  scenario: ScenarioName;
  /** Wall-clock time of the last tick. */
  lastTickAt?: string;
  /** Monotonic time of the last tick. */
  lastTickMonoMs?: number;
  /** Run that is going now. */
  runningRunId?: string;
  /** True from a failed write to the history until the next good one. */
  storageFailed: boolean;
}

/** A run that was started. */
export interface StartedRun {
  /** Discriminant. */
  started: true;
  /** Id of the run. */
  runId: string;
  /** Resolves with the row when the run is finished; never rejects. */
  done: Promise<RunRow>;
}

/** A run that was not started because the scenario is busy. */
export interface BusyScenario {
  /** Discriminant. */
  started: false;
  /** Run that is in the way. */
  runningRunId: string;
}

/** Health split by reason. */
export interface SchedulerHealth {
  /** Every scenario ticked in time and the scheduler is running. */
  scheduler: boolean;
  /** The last write to the history worked. */
  storage: boolean;
  /** Scenarios whose run has been busy longer than the watchdog and the hold after it allow. */
  stuck: ScenarioName[];
}

/** Starts scenario runs on a schedule and watches them. */
export interface Scheduler {
  /** Starts the timers; the first run of the first scenario begins at once. */
  start(): void;
  /**
   * Aborts running runs and records `monitor_stopped`; does not wait for the runs themselves.
   * @returns Resolves when the rows are written.
   */
  stop(): Promise<void>;
  /**
   * Starts a run now unless the scenario is busy; does not move the schedule.
   * @param scenario Scenario to run.
   * @param trigger What asked for the run.
   * @returns The started run or the run in the way.
   */
  runNow(scenario: ScenarioName, trigger: RunTrigger): BusyScenario | StartedRun;
  /**
   * Describes every scheduled scenario.
   * @returns One entry per scenario.
   */
  status(): SchedulerStatus[];
  /**
   * Tells whether the scheduler is alive and its history is writable.
   * @param nowMonoMs Moment to judge at; the clock by default.
   * @returns True when both parts of `health` are.
   */
  healthy(nowMonoMs?: number): boolean;
  /**
   * Splits the health check by reason: the scheduler for the self-exit, both for `/healthz`.
   * @param nowMonoMs Moment to judge at; the clock by default.
   * @returns Which part is healthy.
   */
  health(nowMonoMs?: number): SchedulerHealth;
  /**
   * Lists runs whose scenario may still be touching Hawk.
   * @returns Ids of the running runs and of the abandoned ones until their cleanup timeout passes.
   */
  activeRunIds(): Set<string>;
  /**
   * Tells when a scenario last ended a run that carries a verdict (`ok`, `failed`, or skipped for the rule cache warmup).
   * @param scenario Scenario to ask about.
   * @returns Wall-clock milliseconds of the end of that run, from this process or, before the first one, from the history; undefined when none is known.
   */
  lastVerdictAt(scenario: ScenarioName): number | undefined;
  /**
   * Counts failed writes to the history.
   * @returns Number since the start.
   */
  failures(): number;
}

/** One run in flight. */
interface Handle {
  /** What was recorded at the start. */
  start: RunStart;
  /** Monotonic start. */
  startedMono: number;
  /** Aborts the runner. */
  controller: AbortController;
  /** Cancels the watchdog and the hold. */
  timers: AbortController;
  /** True once the watchdog or `stop` gave the run up. */
  abandoned: boolean;
  /** True once the runner's promise settled. */
  settled: boolean;
  /** True once the row was finished. */
  finished: boolean;
  /** Resolves `done`. */
  resolveDone: (row: RunRow) => void;
  /** Trigger of the run. */
  trigger: RunTrigger;
}

/** Per-scenario state. */
interface ScenarioState {
  /** Scenario. */
  name: ScenarioName;
  /** Position in the configured order. */
  index: number;
  /** Cancels the pending tick. */
  timer?: AbortController;
  /** Monotonic time of the last tick. */
  lastTickMono?: number;
  /** Wall-clock time of the last tick. */
  lastTickAt?: string;
  /** Run that keeps the scenario busy. */
  running?: Handle;
  /** Hung runs in a row. */
  hungStreak: number;
  /** Runs in a row that ended skipped for the rule cache warmup. */
  warmupStreak: number;
  /** Last number given, for a failing history. */
  lastSequence: number;
  /** Number of the last run whose start the history could not store; the next number must follow it. */
  unwritten?: number;
}

/**
 * Describes a thrown value.
 * @param error Anything thrown.
 * @returns Its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Gives the moment a run with a verdict ended.
 * @param row Run that carries a verdict.
 * @returns Wall-clock milliseconds of its end, or of its start when it has no end.
 */
function verdictTime(row: RunRow): number {
  return Date.parse(row.finishedAt ?? row.startedAt);
}

/**
 * Creates the scheduler.
 * @param deps Runners, history, clock, logger, configuration and hooks.
 * @returns Scheduler that is not started yet.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { history, clock, logger, config, redact } = deps;
  const { monitoring } = config;
  const newRunId = deps.newRunId ?? ((): string => createRunId());
  const settingsOf = (scenario: ScenarioName): ScenarioSettings => scenarioSettings(config, scenario);
  const intervalOf = deps.intervalOf ?? ((scenario: ScenarioName): number => settingsOf(scenario).intervalMs);
  const listeners = deps.onRunFinished === undefined ? [] : [deps.onRunFinished].flat();
  const states = new Map<ScenarioName, ScenarioState>();
  const stopper = new AbortController();
  const verdicts = new Map<ScenarioName, number>();
  let started = false;
  let stopped = false;
  let startedMono: number | undefined;
  let storageFailed = false;
  let writeFailures = 0;

  for (const name of monitoring.scenarios.filter(scenario => deps.runners[scenario] !== undefined)) {
    states.set(name, { name,
      index: states.size,
      hungStreak: 0,
      warmupStreak: 0,
      lastSequence: 0 });
  }

  const wallIso = (): string => clock.wallTime().toISOString();
  const thresholdOf = (scenario: ScenarioName): number => intervalOf(scenario) + settingsOf(scenario).watchdogMs;

  /**
   * Runs a callback after a pause unless the signal aborts first.
   * @param ms Pause.
   * @param signal Cancels the pause.
   * @param action Callback; its failure is logged.
   */
  const after = (ms: number, signal: AbortSignal, action: () => Promise<void> | void): void => {
    clock.sleep(ms, signal).then(() => true, () => false)
      .then(async (ran) => {
        if (ran) {
          await action();
        }
      })
      .catch((error: unknown) => {
        logger.error('scheduler timer failed', { error });
      });
  };

  const writeFailed = (what: string, error: unknown): void => {
    storageFailed = true;
    writeFailures += 1;
    logger.error(`history write failed: ${what}`, { error });
  };

  const notify = (row: RunRow, result: RunResult | undefined): void => {
    for (const listener of listeners) {
      try {
        listener(row, result);
      } catch (error) {
        logger.error('run listener failed', { runId: row.runId,
          error });
      }
    }
  };

  const sequenceFor = (state: ScenarioState): number => {
    let sequence: number;

    try {
      // A run that never reached the history leaves the stored maximum behind, so the counter in memory must lead.
      sequence = Math.max(history.nextSequence(state.name), state.unwritten === undefined ? 0 : state.unwritten + 1);
    } catch (error) {
      writeFailed('nextSequence', error);
      sequence = state.lastSequence + 1;
    }

    state.lastSequence = Math.max(state.lastSequence, sequence);

    return sequence;
  };

  const finish = (state: ScenarioState, handle: Handle, outcome: RunOutcome): void => {
    if (handle.finished) {
      return;
    }

    handle.finished = true;

    let row: RunRow | undefined;

    try {
      history.finishRun(handle.start.runId, outcome);
      storageFailed = false;
      row = history.get(handle.start.runId);
    } catch (error) {
      writeFailed('finishRun', error);
    }

    const finalRow = row ?? rowOf(handle.start, outcome);

    if (isVerdict(finalRow)) {
      verdicts.set(finalRow.scenario, verdictTime(finalRow));
    }

    handle.resolveDone(finalRow);
    notify(finalRow, outcome.result);
    state.hungStreak = outcome.errorClass === 'run_hung' ? state.hungStreak : 0;
  };

  const release = (state: ScenarioState, handle: Handle): void => {
    if (state.running === handle) {
      state.running = undefined;
    }
  };

  // `tick` and `scheduleAt` call each other, so the first reaches the second through this holder.
  const hooks = { tick: (_state: ScenarioState): void => undefined };
  const scheduleAt = (state: ScenarioState, delayMs: number): void => {
    state.timer?.abort();

    if (stopped) {
      return;
    }

    state.timer = new AbortController();
    after(Math.max(0, delayMs), state.timer.signal, () => {
      hooks.tick(state);
    });
  };

  const warmupDelay = (result: RunResult): number => {
    const stage = result.stages.find(item => item.name === 'notification_formed');
    const remaining = stage?.details?.warmupRemainingMs;

    return (typeof remaining === 'number' ? remaining : config.notifications.ruleCacheWarmupMs) + RULE_WARMUP_MARGIN_MS;
  };

  const onSettled = (state: ScenarioState, handle: Handle, result: RunResult | undefined, error: unknown): void => {
    handle.settled = true;
    handle.timers.abort();

    if (handle.abandoned) {
      logger.warn(error === undefined ? 'late result of an abandoned run' : 'late failure of an abandoned run', { runId: handle.start.runId });
      // Its cleanup is over, so the scenario need not wait for the hold timer, which the abort above cancelled.
      release(state, handle);

      return;
    }

    release(state, handle);

    const durationMs = clock.monotonicMs() - handle.startedMono;

    if (result === undefined) {
      const text = redact(`scenario threw: ${describe(error)}`);

      logger.error('scenario threw', { runId: handle.start.runId,
        error: redact(error instanceof Error ? error.stack ?? text : text) });
      state.warmupStreak = 0;
      finish(state, handle, abortedOutcome('monitor_internal', { detail: text }, wallIso(), durationMs));

      return;
    }

    let outcome = outcomeOf(result, { loopEnabled: config.notifications.loop });

    if (outcome.status === 'skipped' && outcome.skipReason === 'rule_cache_warmup') {
      state.warmupStreak += 1;

      if (state.warmupStreak >= WARMUP_SKIP_LIMIT) {
        // Skips that repeat would stay silent: the heartbeat counts them and alerting ignores them.
        const failure = new CheckError('provisioning_unstable', { detail: `the notification check was skipped for the rule cache warmup ${String(state.warmupStreak)} runs in a row` });
        const { skipReason: _skipReason, ...kept } = outcome;

        const fields = { errorClass: failure.errorClass,
          culprit: failure.culprit,
          message: failure.message };

        // The stored result must agree with the row, so the copy is failed too; the original is left alone.
        outcome = { ...kept,
          status: 'failed',
          ...fields,
          failedStage: 'notification_formed',
          ...kept.result === undefined
            ? {}
            : { result: { ...kept.result,
                status: 'failed',
                ...fields,
                failedStage: 'notification_formed',
                stages: kept.result.stages.map(stage => stage.name === 'notification_formed'
                  ? { ...stage,
                      status: 'failed',
                      ...fields }
                  : stage) } } };
      }
    } else if (!keepsStreak(outcome)) {
      state.warmupStreak = 0;
    }

    finish(state, handle, outcome);

    if (outcome.skipReason === 'rule_cache_warmup' && handle.trigger === 'schedule') {
      scheduleAt(state, warmupDelay(result));
    }
  };

  const onWatchdog = (state: ScenarioState, handle: Handle): void => {
    if (handle.settled || handle.finished) {
      return;
    }

    handle.abandoned = true;
    handle.controller.abort();
    logger.error('run hung and was abandoned', { runId: handle.start.runId,
      scenario: state.name });
    finish(state, handle, abortedOutcome('run_hung', { waitedMs: settingsOf(state.name).watchdogMs }, wallIso(), clock.monotonicMs() - handle.startedMono));
    state.hungStreak += 1;
    state.warmupStreak = 0;

    if (state.hungStreak >= HUNGS_BEFORE_EXIT) {
      logger.error('three hung runs in a row; exiting', { scenario: state.name });
      deps.exit(1);
    }

    // The scenario stays busy while its cleanup may still be running.
    after(settingsOf(state.name).cleanupMs, handle.timers.signal, () => {
      release(state, handle);
    });
  };

  const startRun = (state: ScenarioState, trigger: RunTrigger): StartedRun => {
    const runner = deps.runners[state.name];

    if (runner === undefined) {
      throw new Error(`No runner for ${state.name}`);
    }

    const runId = newRunId();
    const sequence = sequenceFor(state);
    const start = { runId,
      scenario: state.name,
      sequence,
      trigger,
      startedAt: wallIso() };
    let resolveDone: (row: RunRow) => void = () => undefined;
    const done = new Promise<RunRow>((resolve) => {
      resolveDone = resolve;
    });
    const handle: Handle = { start,
      startedMono: clock.monotonicMs(),
      controller: new AbortController(),
      timers: new AbortController(),
      abandoned: false,
      settled: false,
      finished: false,
      resolveDone,
      trigger };

    try {
      history.startRun(start);
      storageFailed = false;
      state.unwritten = undefined;
    } catch (error) {
      writeFailed('startRun', error);
      state.unwritten = sequence;
    }

    state.running = handle;
    after(settingsOf(state.name).watchdogMs, handle.timers.signal, () => {
      onWatchdog(state, handle);
    });

    let promise: Promise<RunResult>;

    try {
      promise = runner({ runId,
        sequence,
        signal: handle.controller.signal });
    } catch (error) {
      promise = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    promise.then((result) => {
      onSettled(state, handle, result, undefined);
    }, (error: unknown) => {
      onSettled(state, handle, undefined, error ?? new Error('rejected without a reason'));
    });

    return { started: true,
      runId,
      done };
  };

  const skipOverlap = (state: ScenarioState, running: Handle): void => {
    const at = wallIso();
    const skip = { runId: newRunId(),
      scenario: state.name,
      sequence: sequenceFor(state),
      trigger: 'schedule' as const,
      at,
      reason: 'overlap' as const };

    logger.warn('tick skipped, the scenario is still running', { scenario: state.name,
      runningRunId: running.start.runId });

    try {
      history.recordSkip(skip);
      storageFailed = false;
    } catch (error) {
      writeFailed('recordSkip', error);
    }

    notify({ id: 0,
      runId: skip.runId,
      scenario: skip.scenario,
      sequence: skip.sequence,
      trigger: skip.trigger,
      status: 'skipped',
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      skipReason: 'overlap',
      degraded: [],
      stages: [] }, undefined);
  };

  const tick = (state: ScenarioState): void => {
    if (stopped) {
      return;
    }

    state.lastTickMono = clock.monotonicMs();
    state.lastTickAt = wallIso();

    if (state.running !== undefined) {
      skipOverlap(state, state.running);
    } else {
      startRun(state, 'schedule');
    }

    scheduleAt(state, intervalOf(state.name));
  };

  hooks.tick = tick;

  /**
   * Finds when the first tick of a scenario is due.
   * @param state Scenario.
   * @returns Delay in milliseconds: the rest of the old schedule when the last run is younger than the interval, otherwise the stagger.
   */
  const firstDelay = (state: ScenarioState): number => {
    const stagger = state.index * monitoring.staggerMs;

    try {
      const last = history.list({ scenario: state.name,
        limit: LAST_RUNS_LOOKED_AT }).find(row => !(row.status === 'skipped' && row.skipReason === 'overlap'));

      if (last !== undefined) {
        const due = Date.parse(last.startedAt) + intervalOf(state.name) - clock.wallTime().getTime();

        if (due > 0 && due <= intervalOf(state.name)) {
          return due;
        }
      }
    } catch (error) {
      writeFailed('list', error);
    }

    return stagger;
  };

  const firstTick = async (state: ScenarioState): Promise<void> => {
    const delay = firstDelay(state);

    if (delay > 0) {
      try {
        await clock.sleep(delay, stopper.signal);
      } catch {
        return;
      }
    }

    const gate = deps.beforeFirstRun?.[state.name];

    if (gate !== undefined) {
      try {
        await gate(stopper.signal);
      } catch (error) {
        logger.warn('waiting before the first run failed; running anyway', { scenario: state.name,
          error });
      }
    }

    if (!stopped) {
      tick(state);
    }
  };

  const evaluate = (nowMonoMs: number): SchedulerHealth => {
    // Before its first tick a scenario with a gate may wait for the tunnel, which is bounded by its own timeout.
    const allowedMs = (state: ScenarioState): number => thresholdOf(state.name)
      + (state.lastTickMono === undefined && deps.beforeFirstRun?.[state.name] !== undefined ? monitoring.tunnelReadyTimeoutMs : 0);
    const ticking = started && !stopped && [...states.values()].every(state => nowMonoMs - (state.lastTickMono ?? startedMono ?? nowMonoMs) <= allowedMs(state));

    // The watchdog abandons a run at `watchdogMs` and the scenario is held for one more cleanup timeout.
    const stuck = [...states.values()]
      .filter(state => state.running !== undefined && nowMonoMs - state.running.startedMono > settingsOf(state.name).watchdogMs + settingsOf(state.name).cleanupMs)
      .map(state => state.name);

    return { scheduler: ticking,
      storage: !storageFailed,
      stuck };
  };

  const selfCheck = (): void => {
    after(SELF_CHECK_MS, stopper.signal, () => {
      if (!evaluate(clock.monotonicMs()).scheduler) {
        logger.error('a scenario stopped ticking; exiting');
        deps.exit(1);

        return;
      }

      selfCheck();
    });
  };

  const start: Scheduler['start'] = () => {
    if (started) {
      return;
    }

    started = true;
    startedMono = clock.monotonicMs();
    selfCheck();

    for (const state of states.values()) {
      try {
        const last = history.lastVerdict(state.name);

        // A run of this process that ended before this reading is newer than anything the history holds.
        if (last !== undefined && !verdicts.has(state.name)) {
          verdicts.set(state.name, verdictTime(last));
        }
      } catch (error) {
        writeFailed('lastVerdict', error);
      }

      try {
        const recent = history.list({ scenario: state.name,
          limit: WARMUP_SEED_ROWS }).filter(row => !keepsStreak(row));
        const resetAt = recent.findIndex(row => !isWarmupRun(row));

        state.warmupStreak = resetAt === -1 ? recent.length : resetAt;
      } catch (error) {
        writeFailed('list', error);
      }
    }

    for (const state of states.values()) {
      firstTick(state).catch((error: unknown) => {
        logger.error('first tick failed', { scenario: state.name,
          error });
      });
    }
  };

  const stop: Scheduler['stop'] = async () => {
    if (stopped) {
      return;
    }

    stopped = true;
    stopper.abort();

    for (const state of states.values()) {
      state.timer?.abort();

      const handle = state.running;

      if (handle !== undefined && !handle.finished) {
        handle.abandoned = true;
        handle.timers.abort();
        handle.controller.abort();
        finish(state, handle, abortedOutcome('monitor_stopped', {}, wallIso(), clock.monotonicMs() - handle.startedMono));
      }

      handle?.timers.abort();
      state.running = undefined;
    }

    await Promise.resolve();
  };

  const runNow: Scheduler['runNow'] = (scenario, trigger) => {
    const state = states.get(scenario);

    if (state === undefined) {
      throw new Error(`Scenario ${scenario} is not scheduled`);
    }

    if (state.running !== undefined) {
      return { started: false,
        runningRunId: state.running.start.runId };
    }

    return startRun(state, trigger);
  };

  const status: Scheduler['status'] = () => {
    return [...states.values()].map(state => ({ scenario: state.name,
      ...state.lastTickAt === undefined ? {} : { lastTickAt: state.lastTickAt },
      ...state.lastTickMono === undefined ? {} : { lastTickMonoMs: state.lastTickMono },
      ...state.running === undefined ? {} : { runningRunId: state.running.start.runId },
      storageFailed }));
  };

  const healthy: Scheduler['healthy'] = (nowMonoMs) => {
    const health = evaluate(nowMonoMs ?? clock.monotonicMs());

    return health.scheduler && health.storage && health.stuck.length === 0;
  };

  const health: Scheduler['health'] = (nowMonoMs) => {
    return evaluate(nowMonoMs ?? clock.monotonicMs());
  };

  const lastVerdictAt: Scheduler['lastVerdictAt'] = scenario => verdicts.get(scenario);

  const activeRunIds: Scheduler['activeRunIds'] = () => {
    return new Set([...states.values()].flatMap(state => state.running === undefined ? [] : [state.running.start.runId]));
  };

  return {
    start,
    stop,
    runNow,
    status,
    healthy,
    health,
    activeRunIds,
    lastVerdictAt,
    failures: () => writeFailures,
  };
}
