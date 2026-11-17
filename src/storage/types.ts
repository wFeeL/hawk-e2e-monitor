import type { DegradedCode, RunResult, StageName, StageResult } from '../engine/result.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';
import type { LateKind } from '../notifications/types.js';
import type { ScenarioName } from '../scenarios/names.js';

/** Where a run is in its life. */
export type RunStatus = 'aborted' | 'failed' | 'ok' | 'running' | 'skipped';

/** Why a run did not happen or did not count. */
export type SkipReason = 'overlap' | 'rule_cache_warmup';

/** What can start a run. */
export const RUN_TRIGGERS = ['manual', 'schedule'] as const;

/** What started a run. */
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** Alert state of a scenario. */
export type AlertLevelState = 'degraded' | 'failing' | 'ok';

/** One stage as the history keeps it. */
export type StageRow = Pick<StageResult, 'culprit' | 'durationMs' | 'errorClass' | 'name' | 'status'>;

/** One run as the history keeps it. */
export interface RunRow {
  /** Database key; 0 for a row that exists only in memory. */
  id: number;
  /** Random id of the run. */
  runId: string;
  /** Scenario of the run. */
  scenario: ScenarioName;
  /** Run number within the scenario. */
  sequence: number;
  /** What started the run. */
  trigger: RunTrigger;
  /** Status. */
  status: RunStatus;
  /** Wall-clock start, ISO. */
  startedAt: string;
  /** Wall-clock end, ISO. */
  finishedAt?: string;
  /** Duration of the run. */
  durationMs?: number;
  /** Time from the collector's answer to the first sighting of the event. */
  eventLatencyMs?: number;
  /** First failed stage. */
  failedStage?: StageName;
  /** Failure class. */
  errorClass?: ErrorClass;
  /** Culprit of the class. */
  culprit?: Culprit;
  /** Human-readable text of the failure. */
  message?: string;
  /** Why the run was skipped. */
  skipReason?: SkipReason;
  /** Degradation codes of an `ok` run. */
  degraded: DegradedCode[];
  /** When the sweep found the event of a failed run. */
  lateEventFoundAt?: string;
  /** Time from the start of the run to that find. */
  lateEventDelayMs?: number;
  /** When the first notification arrived after the run had ended. */
  lateNotificationAt?: string;
  /** Channel of that notification. */
  lateNotificationChannel?: LateKind;
  /** When a second POST of an already seen channel arrived. */
  lateDuplicateNotificationAt?: string;
  /** Stages in order. */
  stages: StageRow[];
}

/** What a finished run writes to its row. */
export interface RunOutcome {
  /** Final status. */
  status: Exclude<RunStatus, 'running'>;
  /** Wall-clock end, ISO. */
  finishedAt: string;
  /** Duration of the run. */
  durationMs: number;
  /** Reason of a skip. */
  skipReason?: SkipReason;
  /** Degradation codes. */
  degraded: DegradedCode[];
  /** Failure class. */
  errorClass?: ErrorClass;
  /** Culprit of the class. */
  culprit?: Culprit;
  /** Human-readable text of the failure. */
  message?: string;
  /** First failed stage. */
  failedStage?: StageName;
  /** Full result, absent for aborted runs. */
  result?: RunResult;
}

/** Runs a listing returns when the caller gives no limit. */
export const DEFAULT_LIST_LIMIT = 20;

/** What `startRun` records. */
export interface RunStart {
  /** Random id of the run. */
  runId: string;
  /** Scenario. */
  scenario: ScenarioName;
  /** Run number within the scenario. */
  sequence: number;
  /** What started the run. */
  trigger: RunTrigger;
  /** Wall-clock start, ISO. */
  startedAt: string;
}

/** A tick that did not start a run. */
export interface SkipRecord {
  /** Id given to the row. */
  runId: string;
  /** Scenario. */
  scenario: ScenarioName;
  /** Number the next real run would get. */
  sequence: number;
  /** What would have started the run. */
  trigger: RunTrigger;
  /** Time of the tick, ISO. */
  at: string;
  /** Why it did not start. */
  reason: SkipReason;
}

/** Figures of one scenario over a time window. */
export interface StatsWindow {
  /** Runs that ended `ok`. */
  ok: number;
  /** Runs that ended `failed`. */
  failed: number;
  /** Runs aborted for a reason other than a stop or restart of the monitor. */
  aborted: number;
  /** Runs aborted by a stop or restart of the monitor. */
  monitorAborts: number;
  /** Runs that were skipped. */
  skipped: number;
  /** `ok / (ok + failed + aborted)`; null when the denominator is 0. */
  successRatio: number | null;
  /** Median event latency of `ok` runs, nearest rank. */
  eventLatencyP50Ms: number | null;
  /** 95th percentile of the event latency of `ok` runs, nearest rank. */
  eventLatencyP95Ms: number | null;
  /** Rounded mean duration per stage over stage rows that were not skipped, in finished runs. */
  stageAvgMs: Partial<Record<StageName, number>>;
  /** Failed runs whose event the sweep found later. */
  lateEvents: number;
  /** Runs that got a notification after they ended. */
  lateNotifications: number;
  /** Runs that got a repeated notification after they ended. */
  lateDuplicateNotifications: number;
}

/** Statistics of one scenario. */
export interface ScenarioStats {
  /** Scenario. */
  scenario: ScenarioName;
  /** Last 24 hours by start time. */
  last24h: StatsWindow;
  /** Last 7 days by start time. */
  last7d: StatsWindow;
  /** Latest run of any status. */
  lastRun?: Pick<RunRow, 'runId' | 'startedAt' | 'status'>;
}

/** Alert state of a scenario as stored. */
export interface AlertStateRow {
  /** Scenario. */
  scenario: ScenarioName;
  /** Level. */
  state: AlertLevelState;
  /** Failed runs in a row. */
  failureStreak: number;
  /** Class of the last failure. */
  lastClass?: string;
  /** Stage of the last failure. */
  lastStage?: string;
  /** Run of the last failure. */
  lastRunId?: string;
  /** Start of the run that opened the episode. */
  episodeStartedAt?: string;
  /** Failed runs in the episode. */
  episodeFailures: number;
  /** Degradation codes of the last `ok` run. */
  degraded: DegradedCode[];
  /** Last change, ISO. */
  updatedAt: string;
}

/** An alert waiting for delivery. */
export interface OutboxRow {
  /** Database key. */
  id: number;
  /** Scenario. */
  scenario: ScenarioName;
  /** Run that caused the alert. */
  runId?: string;
  /** Text to send. */
  text: string;
  /** When it was queued, ISO. */
  createdAt: string;
  /** Delivery attempts so far. */
  attempts: number;
  /** Earliest next attempt, ISO. */
  nextAttemptAt: string;
}

/** What `alertAttempt` records. */
export interface AlertAttempt {
  /** Delivery time. */
  sentAt?: string;
  /** Earliest next attempt. */
  nextAttemptAt?: string;
  /** Time the message was given up on. */
  droppedAt?: string;
  /** Text of the failure. */
  error?: string;
}

/** A run row with its full result. */
export type RunWithResult = RunRow & {
  /** Result as the scenario returned it. */
  result?: RunResult;
};

/** Filter and size of `list`. */
export interface ListOptions {
  /** Only runs of this scenario. */
  scenario?: ScenarioName;
  /** Leaves out the runs of these scenarios. */
  exceptScenarios?: readonly ScenarioName[];
  /** Most rows to return. */
  limit: number;
}

/** What `prune` is limited to. */
export interface PruneOptions {
  /** Only runs and delivered alerts of this scenario; all of them by default. */
  scenario?: ScenarioName;
  /** Only runs and delivered alerts of scenarios that are not listed, such as ones the code no longer knows; ignored with `scenario`. */
  exceptScenarios?: readonly ScenarioName[];
}

/** A message to queue together with a state change. */
export interface AlertMessage {
  /** Text to send. */
  text: string;
  /** Run that caused the message. */
  runId?: string;
  /** Time of the change, ISO. */
  at: string;
}
