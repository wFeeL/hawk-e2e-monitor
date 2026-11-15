import type { Config } from '../config/load.js';
import type { RunResult } from '../engine/result.js';
import { CheckError } from '../errors/taxonomy.js';
import type { ErrorClass, MessageFacts } from '../errors/taxonomy.js';
import type { ScenarioName } from '../scenarios/send-and-receive/plan.js';
import type { RunStart } from './history.js';
import type { DegradedCode, RunOutcome, RunRow } from './types.js';

const DAYS_PER_PERIOD = 30;
const MS_PER_DAY = 86_400_000;

/** What `outcomeOf` needs to know besides the result. */
export interface OutcomeContext {
  /** Events per 30 days that all enabled scenarios will send; absent turns the quota check off. */
  projectedEventsPer30Days?: number;
  /** Whether the notification rule has the loop channel. */
  loopEnabled: boolean;
}

/**
 * Reads the event limit that the `api_availability` stage recorded.
 * @param result Finished run.
 * @returns The limit, or undefined when it is missing or not a number.
 */
function recordedEventsLimit(result: RunResult): number | undefined {
  const quota = result.stages.find(stage => stage.name === 'api_availability')?.details?.quota;
  const limit = typeof quota === 'object' && quota !== null ? (quota as Record<string, unknown>).eventsLimit : undefined;

  return typeof limit === 'number' ? limit : undefined;
}

/**
 * Lists the degradation codes of an `ok` run.
 * @param result Finished run with status `ok`.
 * @param context Loop switch and the projected spend.
 * @returns Codes in a fixed order.
 */
function degradationOf(result: RunResult, context: OutcomeContext): DegradedCode[] {
  const codes: DegradedCode[] = [];
  const { notification } = result;

  if (result.scenario === 'check-notification' && notification !== undefined
    && (notification.webhook === undefined || (context.loopEnabled && notification.loop === undefined))) {
    codes.push('single_channel');
  }

  const limit = recordedEventsLimit(result);

  if (limit !== undefined && context.projectedEventsPer30Days !== undefined && context.projectedEventsPer30Days > limit) {
    codes.push('quota_projection');
  }

  return codes;
}

/**
 * Turns a finished result into what the history stores: status, skip reason and degradation.
 * @param result Result of a scenario run.
 * @param context Loop switch and the projected spend.
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

/**
 * Counts the events a scenario sends per run on average.
 * @param scenario Scenario whose events are counted.
 * @param config Configuration with the transport mode and the repeat period.
 * @returns `check-notification` 1; `send-and-receive-event` 1 plus the share of runs that repeat the event.
 */
export function eventsPerRun(scenario: ScenarioName, config: Config): number {
  if (scenario === 'check-notification' || config.repeatEveryNRuns === 0) {
    return 1;
  }

  // In `alternate` mode the period counts runs of one transport, so only every second run advances it.
  const period = config.transportMode === 'alternate' ? 2 * config.repeatEveryNRuns : config.repeatEveryNRuns;

  return 1 + 1 / period;
}

/**
 * Projects the events the enabled scenarios send in 30 days.
 * @param config Configuration with the scenarios and the interval.
 * @returns Sum over the scenarios of events per run times runs in 30 days.
 */
export function projectedEventsPer30Days(config: Config): number {
  const runs = DAYS_PER_PERIOD * MS_PER_DAY / config.monitoring.intervalMs;

  return config.monitoring.scenarios.reduce((sum, scenario) => sum + eventsPerRun(scenario, config) * runs, 0);
}
