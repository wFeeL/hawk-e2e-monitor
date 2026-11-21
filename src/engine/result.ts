import type { Transport } from '../clients/collector.js';
import type { Culprit, ErrorClass } from '../errors/taxonomy.js';
import type { ArrivalKind } from '../notifications/types.js';

/** Stages of a run, in execution order. */
export const STAGE_NAMES = [
  'collector_availability',
  'api_availability',
  'telegram_ready',
  'notification_setup',
  'project_created',
  'token_accepted',
  'release_uploaded',
  'release_saved',
  'collector_accept',
  'event_visible',
  'notification_formed',
  'telegram_delivered',
  'telegram_probe',
  'event_repeated',
  'threshold_formed',
  'cleanup',
  'garage_availability',
  'receiver_availability',
] as const;

/** One of `STAGE_NAMES`. */
export type StageName = (typeof STAGE_NAMES)[number];

/** Ways a stage can end. */
export const STAGE_STATUSES = ['ok', 'failed', 'uncertain', 'skipped'] as const;

/** How a stage ended. */
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Conditions under which an `ok` run still deserves a warning. */
export const DEGRADED_CODES = [
  'quota_usage',
  'single_channel',
  'accept_uncertain',
  'js_worker_not_seen',
  'grouping_pattern',
] as const;

/** One of `DEGRADED_CODES`. */
export type DegradedCode = (typeof DEGRADED_CODES)[number];

/** Stage data; the keys read outside the stage that writes them are typed. */
export interface StageDetails {
  /** One line the run reports as a warning. */
  warning?: string;
  /** Several warnings the run reports. */
  warnings?: string[];
  /** Degradation codes the stage names itself. */
  degraded?: DegradedCode[];
  /** Why the stage was skipped. */
  reason?: 'rule_cache_warmup' | 'tunnel_starting';
  /** Time left of the rule cache warmup. */
  warmupRemainingMs?: number;
  /** How the recount before cleanup went. */
  recheck?: 'skipped' | 'missing' | 'failed';
  /** Time the stage waited before it gave up. */
  waitedMs?: number;
  /** True when the event was found by the search after the visible stage gave up. */
  foundBySearch?: boolean;
  /** True when the event quota is almost used. */
  quotaLow?: boolean;
  /** Count of the event seen by the recount before cleanup. */
  lateTotalCount?: number;
  /** True when the collector did not confirm the repeated event. */
  repeatUncertain?: boolean;
  /** How the poll for the event ended. */
  pollOutcome?: 'found' | 'not_found' | 'api_error';
  /** Id of the event the stage deleted or compared. */
  originalEventId?: string;
  /** Id of the event named in the webhook. */
  eventId?: string;
  /** Latency in ms, or per channel. */
  latencyMs?: number | Partial<Record<ArrivalKind, number>>;
  [key: string]: unknown;
}

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
  details?: StageDetails;
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
  /** The threshold notification, which the repeated event triggers. */
  threshold?: {
    /** Time from the collector's answer to the repeat to the threshold POST. */
    latencyMs: number;
  };
  /** The webhook of the Telegram rule. */
  telegram?: {
    /** Time from the collector's answer to the first POST. */
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

/** What the run learned from the chat of the `telegram-delivery` scenario. */
export interface RunTelegram {
  /** Time from the collector's answer to the message of Hawk in the chat. */
  latencyMs?: number;
  /** Messages of the chat that were not the one awaited. */
  unmatched: number;
  /** The probe sent through @codex_bot, when the message of Hawk did not come. */
  probe?: {
    /** Wall-clock time the probe was sent, ISO. */
    sentAt: string;
    /** Time from the send to the arrival of the probe in the chat. */
    arrivedMs?: number;
    /** Time from the collector's answer to a message of Hawk that came while the probe was awaited. */
    lateHawkMessageMs?: number;
  };
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
  /** Transport the event was sent over; absent for a scenario that sends none. */
  transport?: Transport;
  /** Catcher type of the event; absent for a scenario that sends none. */
  catcherType?: string;
  /** Title of the event; absent for a scenario that sends none. */
  title?: string;
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
  /** Provisioning, for `check-notification` and `telegram-delivery` runs that got past the setup. */
  provisioning?: RunProvisioning;
  /** The chat, for `telegram-delivery` runs that got to read it. */
  telegram?: RunTelegram;
}
