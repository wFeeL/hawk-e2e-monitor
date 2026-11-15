import type { Transport } from '../clients/collector.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';

/** Stages of a run, in execution order. */
export const STAGE_NAMES = ['collector_availability', 'api_availability', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'event_repeated', 'cleanup'] as const;

/** One of `STAGE_NAMES`. */
export type StageName = (typeof STAGE_NAMES)[number];

/** How a stage ended. */
export type StageStatus = 'ok' | 'failed' | 'uncertain' | 'skipped';

/** Recorded outcome of one stage. */
export interface StageResult {
  /** Stage name. */
  name: StageName;
  /** How the stage ended. */
  status: StageStatus;
  /** Wall-clock start, ISO. */
  startedAt: string;
  /** Monotonic duration. */
  durationMs: number;
  /** Failure class; for `uncertain` the class of the reason. */
  errorClass?: ErrorClass;
  /** Culprit of the class. */
  culprit?: Culprit;
  /** Human-readable text of the error. */
  message?: string;
  /** Stage-specific data. */
  details?: Record<string, unknown>;
}

/** Outcome of the cleanup stage. */
export interface CleanupResult {
  /** How cleanup ended. */
  status: 'ok' | 'failed' | 'skipped' | 'refused';
  /** Failure class. */
  errorClass?: ErrorClass;
  /** Human-readable text of the error. */
  message?: string;
}

/** The event the run found in Hawk. */
export interface RunEvent {
  /** Id of the original event. */
  originalEventId: string;
  /** Grouping hash. */
  groupHash: string;
  /** Number of repetitions counted by Hawk. */
  totalCount: number;
}

/** What the run learned about the notifications of its event. */
export interface RunNotification {
  /** The webhook notification. */
  webhook?: {
    /** Time from the collector's answer to the first webhook POST. */
    latencyMs: number;
    /** Id of the event named in the webhook, when the body had one. */
    eventId?: string;
  };
  /** The loop notification. */
  loop?: {
    /** Time from the collector's answer to the first loop POST. */
    latencyMs: number;
  };
  /** POSTs with a valid secret but no run id of this run. */
  unmatched: number;
}

/** What provisioning did for this run. */
export interface RunProvisioning {
  /** Whether the rule was left, created or replaced. */
  action: 'none' | 'created' | 'updated';
  /** Extra rules deleted. */
  deleted: number;
  /** Whether matching changed. */
  matchChanged: boolean;
}

/** Everything a run reports. */
export interface RunResult {
  /** Random id of the run. */
  runId: string;
  /** Scenario name. */
  scenario: string;
  /** Monitor instance id. */
  instanceId: string;
  /** Run number. */
  sequence: number;
  /** Transport the event was sent over. */
  transport: Transport;
  /** Catcher type of the event. */
  catcherType: string;
  /** Title of the event. */
  title: string;
  /** Wall-clock start, ISO. */
  startedAt: string;
  /** Wall-clock end, ISO. */
  finishedAt: string;
  /** Monotonic duration of the run. */
  durationMs: number;
  /** Verdict. */
  status: 'ok' | 'failed';
  /** First failed stage. */
  failedStage?: StageName;
  /** Class of the failure. */
  errorClass?: ErrorClass;
  /** Culprit of the failure. */
  culprit?: Culprit;
  /** Human-readable text of the failure. */
  message?: string;
  /** Non-fatal remarks. */
  warnings: string[];
  /** Whether the event may have reached the collector. */
  sendMayHaveReached: boolean;
  /** The found event. */
  event?: RunEvent;
  /** Time from the collector's answer to the first sighting. */
  eventLatencyMs?: number;
  /** All stages in order. */
  stages: StageResult[];
  /** Outcome of cleanup. */
  cleanup: CleanupResult;
  /** Notifications, for `check-notification` runs that got to read them. */
  notification?: RunNotification;
  /** Provisioning, for `check-notification` runs that got past the setup. */
  provisioning?: RunProvisioning;
}
