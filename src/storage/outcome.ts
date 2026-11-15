import type { Config } from '../config/load.js';
import type { RunResult } from '../engine/result.js';
import { CheckError } from '../errors/taxonomy.js';
import type { ErrorClass, MessageFacts } from '../errors/taxonomy.js';
import { scenarioSettings } from '../config/scenario.js';
import { CHECK_NOTIFICATION, EVENT_SCENARIOS } from '../scenarios/names.js';
import type { RunStart } from './history.js';
import { DEGRADED_CODES } from './types.js';
import type { DegradedCode, RunOutcome, RunRow } from './types.js';
import { MS_PER_DAY } from '../time/units.js';

const DAYS_PER_PERIOD = 30;
const MONITOR_ABORTS: readonly ErrorClass[] = ['monitor_stopped', 'monitor_restarted'];

/** What `outcomeOf` needs to know besides the result. */
export interface OutcomeContext {
  /** Whether the notification rule has the loop channel. */
  loopEnabled: boolean;
}

/**
 * Lists the degradation codes of an `ok` run.
 * @param result Finished run with status `ok`.
 * @param context Loop switch.
 * @returns Codes in a fixed order.
 */
function degradationOf(result: RunResult, context: OutcomeContext): DegradedCode[] {
  const codes: DegradedCode[] = [];
  const { notification } = result;

  if (result.scenario === CHECK_NOTIFICATION && notification !== undefined
    && (notification.webhook === undefined || (context.loopEnabled && notification.loop === undefined))) {
    codes.push('single_channel');
  }

  // The quota stage marks a nearly used event limit; the monitor's own events do not count, because cleanup removes them.
  if (result.stages.find(stage => stage.name === 'api_availability')?.details?.quotaLow === true) {
    codes.push('quota_usage');
  }

  // Stages name the other degradations themselves, in `details.degraded`.
  const reported = new Set(result.stages.flatMap(stage => Array.isArray(stage.details?.degraded) ? stage.details.degraded as unknown[] : []));

  for (const code of DEGRADED_CODES) {
    if (reported.has(code) && !codes.includes(code)) {
      codes.push(code);
    }
  }

  return codes;
}

/**
 * Turns a finished result into what the history stores: status, skip reason and degradation.
 * @param result Result of a scenario run.
 * @param context Loop switch.
 * @returns Outcome with the result attached.
 */
export function outcomeOf(result: RunResult, context: OutcomeContext): RunOutcome {
  const base = { finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    result };

  if (result.status === 'failed') {
    return { ...base,
      status: 'failed',
      degraded: [],
      ...result.errorClass === undefined ? {} : { errorClass: result.errorClass },
      ...result.culprit === undefined ? {} : { culprit: result.culprit },
      ...result.message === undefined ? {} : { message: result.message },
      ...result.failedStage === undefined ? {} : { failedStage: result.failedStage } };
  }

  const warmup = result.stages.some(stage => stage.name === 'notification_formed' && stage.status === 'skipped'
    && stage.details?.reason === 'rule_cache_warmup');

  if (warmup) {
    return { ...base,
      status: 'skipped',
      skipReason: 'rule_cache_warmup',
      degraded: [] };
  }

  return { ...base,
    status: 'ok',
    degraded: degradationOf(result, context) };
}

/**
 * Builds the outcome of a run that has no result: hung, stopped, restarted or thrown.
 * @param errorClass Class of the abort.
 * @param facts Facts for the text.
 * @param at End time, ISO.
 * @param durationMs Time since the start of the run.
 * @returns Aborted outcome with the class text and culprit.
 */
export function abortedOutcome(errorClass: ErrorClass, facts: MessageFacts, at: string, durationMs: number): RunOutcome {
  const error = new CheckError(errorClass, facts);

  return { status: 'aborted',
    finishedAt: at,
    durationMs,
    degraded: [],
    errorClass,
    culprit: error.culprit,
    message: error.message };
}

/**
 * Builds the row a run would have in the history, for a write that failed.
 * @param start What was recorded when the run started.
 * @param outcome How it ended.
 * @returns Row with `id` 0.
 */
export function rowOf(start: RunStart, outcome: RunOutcome): RunRow {
  const { result } = outcome;

  return { id: 0,
    ...start,
    status: outcome.status,
    finishedAt: outcome.finishedAt,
    durationMs: outcome.durationMs,
    ...result?.eventLatencyMs === undefined ? {} : { eventLatencyMs: result.eventLatencyMs },
    ...outcome.failedStage === undefined ? {} : { failedStage: outcome.failedStage },
    ...outcome.errorClass === undefined ? {} : { errorClass: outcome.errorClass },
    ...outcome.culprit === undefined ? {} : { culprit: outcome.culprit },
    ...outcome.message === undefined ? {} : { message: outcome.message },
    ...outcome.skipReason === undefined ? {} : { skipReason: outcome.skipReason },
    degraded: outcome.degraded,
    stages: (result?.stages ?? []).map(stage => ({ name: stage.name,
      status: stage.status,
      durationMs: stage.durationMs,
      ...stage.errorClass === undefined ? {} : { errorClass: stage.errorClass },
      ...stage.culprit === undefined ? {} : { culprit: stage.culprit } })) };
}

/** What `isVerdict` may count besides the plain verdicts. */
export interface VerdictOptions {
  /** Also counts an `aborted` run that is not a stop or restart of the monitor. */
  aborts?: boolean;
}

/** The part of a run that tells whether it carries a verdict. */
export type VerdictFields = Pick<RunRow, 'status'> & Partial<Pick<RunRow, 'errorClass' | 'skipReason'>>;

/**
 * Tells whether a run ended because the monitor was stopped or restarted, which says nothing about Hawk.
 * @param row Run to judge.
 * @returns True for an `aborted` run of class `monitor_stopped` or `monitor_restarted`.
 */
export function isMonitorAbort(row: VerdictFields): boolean {
  return row.status === 'aborted' && row.errorClass !== undefined && MONITOR_ABORTS.includes(row.errorClass);
}

/**
 * Tells whether a run says something about the health of Hawk: `ok`, `failed` or a skip for the rule cache warmup.
 * @param row Run to judge.
 * @param options `aborts` also counts an `aborted` run that is not a stop or restart of the monitor, such as a hung run.
 * @returns True when the run carries a verdict.
 */
export function isVerdict(row: VerdictFields, options: VerdictOptions = {}): boolean {
  if (row.status === 'ok' || row.status === 'failed') {
    return true;
  }

  if (row.status === 'skipped') {
    return row.skipReason === 'rule_cache_warmup';
  }

  return options.aborts === true && row.status === 'aborted' && !isMonitorAbort(row);
}

/**
 * Counts the events a run sends on average; both scenarios repeat the event by the same rule.
 * @param config Configuration with the transport mode and the repeat period.
 * @returns 1 plus the share of runs that repeat the event.
 */
export function eventsPerRun(config: Config): number {
  if (config.repeatEveryNRuns === 0) {
    return 1;
  }

  // In `alternate` mode the period counts runs of one transport, so only every second run advances it.
  const period = config.transportMode === 'alternate' ? 2 * config.repeatEveryNRuns : config.repeatEveryNRuns;

  return 1 + 1 / period;
}

/**
 * Counts the events the enabled scenarios send in 30 days; the quota ignores them once cleanup removes them, but the rate limits of the plan apply.
 * @param config Configuration with the scenarios and the interval.
 * @returns Events per run times runs in 30 days, summed over the scenarios.
 */
export function eventsSentPer30Days(config: Config): number {
  const events = eventsPerRun(config);

  return config.monitoring.scenarios
    .filter(scenario => EVENT_SCENARIOS.includes(scenario))
    .reduce((sum, scenario) => sum + events * DAYS_PER_PERIOD * MS_PER_DAY / scenarioSettings(config, scenario).intervalMs, 0);
}
