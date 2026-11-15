import { describeError } from './messages.js';

/** Every failure class a check run can end with. */
export const ERROR_CLASSES = [
  'collector_unavailable', 'dns_error', 'network_error', 'tls_error',
  'collector_dependency_error', 'collector_unexpected_response', 'ws_handshake_failed',
  'auth_invalid_token', 'bad_request', 'quota_exhausted', 'rate_limited', 'unknown_402',
  'payload_too_large', 'ip_blacklisted', 'accept_uncertain', 'api_unavailable', 'api_unexpected_response',
  'api_query_rejected', 'api_auth_failed', 'api_forbidden', 'token_mismatch',
  'workspace_blocked', 'api_error', 'event_not_found', 'event_mismatch',
  'duplicate_event', 'repeat_not_counted', 'cleanup_failed', 'cleanup_refused',
  'api_garage_query_failed', 'field_not_masked', 'threshold_early', 'new_token_not_accepted',
  'release_rejected', 'release_not_saved', 'sourcemap_not_applied', 'sentry_rejected',
  'monitor_internal', 'run_timeout', 'tunnel_unavailable', 'receiver_unreachable',
  'notification_endpoint_rejected', 'provisioning_conflict', 'provisioning_unstable',
  'notification_timeout', 'notification_mismatch', 'duplicate_notification',
  'run_hung', 'monitor_restarted', 'monitor_stopped', 'alert_rejected',
  'garage_unavailable', 'telegram_auth_failed', 'telegram_conflict', 'telegram_bot_misconfigured',
  'telegram_api_unavailable', 'telegram_bot_unavailable', 'telegram_not_delivered',
] as const;

/** One of `ERROR_CLASSES`. */
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Who can be to blame for a failure. */
export const CULPRITS = ['hawk', 'monitor', 'config', 'network'] as const;

/** One of `CULPRITS`. */
export type Culprit = (typeof CULPRITS)[number];

/** Culprit of each class. */
export const CULPRIT_OF: Readonly<Record<ErrorClass, Culprit>> = Object.fromEntries([
  ['collector_unavailable', 'hawk'],
  ['dns_error', 'hawk'],
  ['network_error', 'network'],
  ['tls_error', 'hawk'],
  ['collector_dependency_error', 'hawk'],
  ['collector_unexpected_response', 'hawk'],
  ['ws_handshake_failed', 'hawk'],
  ['auth_invalid_token', 'config'],
  ['bad_request', 'monitor'],
  ['quota_exhausted', 'monitor'],
  ['rate_limited', 'monitor'],
  ['unknown_402', 'hawk'],
  ['payload_too_large', 'monitor'],
  ['ip_blacklisted', 'monitor'],
  ['accept_uncertain', 'hawk'],
  ['api_unavailable', 'hawk'],
  ['api_unexpected_response', 'hawk'],
  ['api_query_rejected', 'monitor'],
  ['api_auth_failed', 'config'],
  ['api_forbidden', 'config'],
  ['token_mismatch', 'config'],
  ['workspace_blocked', 'monitor'],
  ['api_error', 'hawk'],
  ['event_not_found', 'hawk'],
  ['event_mismatch', 'hawk'],
  ['duplicate_event', 'hawk'],
  ['repeat_not_counted', 'hawk'],
  ['cleanup_failed', 'hawk'],
  ['cleanup_refused', 'monitor'],
  ['api_garage_query_failed', 'hawk'],
  ['field_not_masked', 'hawk'],
  ['threshold_early', 'hawk'],
  ['new_token_not_accepted', 'hawk'],
  ['release_rejected', 'hawk'],
  ['release_not_saved', 'hawk'],
  ['sourcemap_not_applied', 'hawk'],
  ['sentry_rejected', 'hawk'],
  ['monitor_internal', 'monitor'],
  ['run_timeout', 'monitor'],
  ['tunnel_unavailable', 'monitor'],
  ['receiver_unreachable', 'monitor'],
  ['notification_endpoint_rejected', 'config'],
  ['provisioning_conflict', 'monitor'],
  ['provisioning_unstable', 'monitor'],
  ['notification_timeout', 'hawk'],
  ['notification_mismatch', 'hawk'],
  ['duplicate_notification', 'hawk'],
  ['run_hung', 'monitor'],
  ['monitor_restarted', 'monitor'],
  ['monitor_stopped', 'monitor'],
  ['alert_rejected', 'config'],
  ['garage_unavailable', 'hawk'],
  ['telegram_auth_failed', 'config'],
  ['telegram_conflict', 'config'],
  ['telegram_bot_misconfigured', 'config'],
  ['telegram_api_unavailable', 'network'],
  ['telegram_bot_unavailable', 'network'],
  ['telegram_not_delivered', 'hawk'],
] satisfies readonly (readonly [ErrorClass, Culprit])[]) as Record<ErrorClass, Culprit>;

/** Facts a message may mention; absent facts are skipped. */
export interface MessageFacts {
  /** Stage name; kept for results, not printed. */
  stage?: string;
  /** Address that was requested. */
  url?: string;
  /** Host name. */
  host?: string;
  /** HTTP status. */
  status?: number;
  /** Network or protocol code. */
  code?: string;
  /** How long the monitor waited. */
  waitedMs?: number;
  /** Text of the underlying error. */
  cause?: string;
  /** Name of a compared field. */
  field?: string;
  /** Expected value of the field. */
  expected?: string;
  /** Actual value of the field. */
  actual?: string;
  /** A count, such as `totalCount`. */
  count?: number;
  /** Successful API answers. */
  successes?: number;
  /** Failed API answers. */
  errors?: number;
  /** Time since the last successful API answer. */
  lastSuccessAgoMs?: number;
  /** Free-form detail. */
  detail?: string;
  /** Project id. */
  projectId?: string;
  /** Notification channel, `webhook` or `loop`. */
  channel?: string;
}

/** Cause and optional text override for a `CheckError`. */
export interface CheckErrorOptions extends ErrorOptions {
  /** Replaces the text built by `describeError`. */
  message?: string;
  /** Replaces the culprit of the class, for a class whose blame depends on the case. */
  culprit?: Culprit;
}

/** A failure with a taxonomy class, culprit and human-readable text. */
export class CheckError extends Error {
  public readonly errorClass: ErrorClass;
  public readonly culprit: Culprit;
  public readonly facts: MessageFacts;

  /**
   * Creates the error.
   * @param errorClass Taxonomy class.
   * @param facts Facts for the text.
   * @param options Cause and an optional replacement text.
   */
  constructor(errorClass: ErrorClass, facts: MessageFacts = {}, options: CheckErrorOptions = {}) {
    const { message, culprit, ...errorOptions } = options;

    super(message ?? describeError(errorClass, facts), errorOptions);
    this.name = 'CheckError';
    this.errorClass = errorClass;
    this.culprit = culprit ?? CULPRIT_OF[errorClass];
    this.facts = facts;
  }
}

/**
 * Tells whether a value is a `CheckError`.
 * @param value Anything.
 * @returns True for `CheckError` instances.
 */
export function isCheckError(value: unknown): value is CheckError {
  return value instanceof CheckError;
}
