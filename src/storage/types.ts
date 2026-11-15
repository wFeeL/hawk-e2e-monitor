import type { RunResult, StageName, StageResult } from '../engine/result.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';
import type { NotificationChannel } from '../notifications/types.js';
import type { ScenarioName } from '../scenarios/send-and-receive/plan.js';

/** Where a run is in its life. */
export type RunStatus = 'aborted' | 'failed' | 'ok' | 'running' | 'skipped';

/** Why a run did not happen or did not count. */
export type SkipReason = 'overlap' | 'rule_cache_warmup';

/** What started a run. */
export type RunTrigger = 'manual' | 'schedule';

/** A condition under which an `ok` run still deserves a warning. */
export type DegradedCode = 'quota_projection' | 'single_channel';

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
  lateNotificationChannel?: NotificationChannel;
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
