import { formatDuration } from '../time/format.js';
import type { ErrorClass, MessageFacts } from './taxonomy.js';

/**
 * Names a failure by its code or, failing that, its HTTP status.
 * @param facts Facts of the message.
 * @returns Code, `HTTP <status>`, or undefined.
 */
function codeOrStatus(facts: MessageFacts): string | undefined {
  if (facts.code === 'BAD_PORT') {
    return 'the port is blocked by fetch, use another one';
  }

  if (facts.code !== undefined) {
    return facts.code;
  }

  return facts.status === undefined ? undefined : `HTTP ${String(facts.status)}`;
}

/**
 * Joins a base text with phrases; absent phrases are skipped whole.
 * @param base Always-present start.
 * @param parts Optional `[separator, text]` pairs.
 * @returns Joined text.
 */
function join(base: string, ...parts: readonly (readonly [string, string | undefined])[]): string {
  let text = base;

  for (const [separator, value] of parts) {
    if (value !== undefined) {
      text += separator + value;
    }
  }

  return text;
}

/**
 * Formats an optional value with a template.
 * @param value Fact or undefined.
 * @param format Builds the phrase.
 * @returns Phrase or undefined.
 */
function ifSet<T>(value: T | undefined, format: (present: T) => string): string | undefined {
  return value === undefined ? undefined : format(value);
}

/**
 * Appends a `: detail` tail when the detail is known.
 * @param base Text start.
 * @param detail Optional detail.
 * @returns Text.
 */
function withDetail(base: string, detail: string | undefined): string {
  return join(base, [': ', detail]);
}

/**
 * Builds the text of `notification_timeout`, which names the conclusion from `detail`.
 * @param facts Facts of the message; `detail` is `webhook_only` when the loop channel is off.
 * @returns English text.
 */
function notificationTimeoutText(facts: MessageFacts): string {
  const within = ifSet(facts.waitedMs, ms => ` within ${formatDuration(ms)}`) ?? '';

  if (facts.channel === 'threshold') {
    return `The threshold notification did not arrive${within}: the repeated event reached the notifier, but the rule that counts repetitions sent nothing`;
  }

  return facts.detail === 'webhook_only'
    ? `The webhook did not arrive${within}; with the loop channel off the notifier and the sender cannot be told apart`
    : `Neither channel arrived${within}: the notifier or its queue did not hand the notification to a sender`;
}

/**
 * Builds the human-readable text of a failure class.
 * @param errorClass Taxonomy class.
 * @param facts Facts to mention; absent ones are skipped.
 * @returns English text without secrets.
 */
export function describeError(errorClass: ErrorClass, facts: MessageFacts): string {
  const where = facts.url === undefined ? 'Collector' : `Collector ${facts.url}`;
  const what = codeOrStatus(facts);
  const waited = ifSet(facts.waitedMs, ms => `waited ${formatDuration(ms)}`);

  switch (errorClass) {
    case 'collector_unavailable':
      return join(`${where} did not respond`, [': ', what], [', ', waited], ['; cause: ', facts.cause]);
    case 'dns_error':
      return join(`Host ${facts.host ?? facts.url ?? 'of the request'} does not resolve`, [': ', facts.code]);
    case 'network_error':
      return join('Monitor network failure', [': ', what], [' for ', facts.url]);
    case 'tls_error':
      return join(`TLS failure for ${facts.host ?? facts.url ?? 'the host'}`, [': ', facts.code]);
    case 'collector_dependency_error':
      return withDetail('Collector reports a broken dependency (Redis or Mongo)', facts.detail);
    case 'collector_unexpected_response':
      return join(`${where} gave an unexpected response`, [': ', what], [' (', ifSet(facts.detail, text => `${text})`)],
        ['; check HAWK_COLLECTOR_URL', '']);
    case 'ws_handshake_failed':
      return join(`WebSocket ${facts.url ?? 'of the collector'} did not open`, [': ', facts.detail]);
    case 'auth_invalid_token':
      return withDetail('Collector rejected the integration token', facts.detail);
    case 'bad_request':
      return withDetail('Collector rejected the event', facts.detail);
    case 'quota_exhausted':
      return withDetail('Event limit is exhausted or the workspace is not paid', facts.detail);
    case 'rate_limited':
      return withDetail('Collector rate limit exceeded', facts.detail);
    case 'unknown_402':
      return withDetail('Collector answered 402', facts.detail);
    case 'payload_too_large':
      return withDetail('Event is larger than the collector limit', facts.detail);
    case 'ip_blacklisted':
      return 'Monitor IP is in the collector blacklist (429 Too Many Requests)';
    case 'accept_uncertain':
      return join(`${where} did not confirm the event`, [': ', what], ['; the run keeps looking for it', '']);
    case 'api_unavailable':
      return join(`API ${facts.url ?? 'endpoint'} did not respond`, [': ', what], [', ', waited]);
    case 'api_query_rejected':
      return withDetail('Monitor query was rejected by the API schema; did the API version change?', facts.detail);
    case 'api_auth_failed':
      return join('Hawk API rejected the monitor account', [': ', facts.detail], ['. Check HAWK_EMAIL and HAWK_PASSWORD', '']);
    case 'api_forbidden':
      return join('No access to the project', [' ', facts.projectId], [': ', facts.detail]);
    case 'token_mismatch':
      return 'The integration token belongs to another project than HAWK_PROJECT_ID';
    case 'workspace_blocked':
      return withDetail('Workspace is blocked: limit or payment', facts.detail);
    case 'api_error':
      return withDetail('API returned an error', facts.detail);
    case 'event_not_found': {
      const start = ifSet(facts.waitedMs, ms => `Event did not appear within ${formatDuration(ms)}`) ?? 'Event did not appear';
      const lastAnswer = facts.successes === 0 ? undefined : ifSet(facts.lastSuccessAgoMs, ms => `last answer ${formatDuration(ms)} ago`);

      return join(start,
        [': ', ifSet(facts.successes, count => `API answered ${String(count)} times`)],
        [', ', ifSet(facts.errors, count => `failed ${String(count)} times`)],
        [', ', lastAnswer]);
    }
    case 'event_mismatch':
      return join(`Event field ${facts.field ?? 'value'} differs`,
        [': expected ', facts.expected], [', got ', facts.actual]);
    case 'duplicate_event':
      return join('Event was counted more than once', [': ', ifSet(facts.count, count => `${String(count)} times`)]);
    case 'repeat_not_counted':
      return join('The repeated event was not counted', [': totalCount is ', ifSet(facts.count, String)], [' after ', ifSet(facts.waitedMs, formatDuration)]);
    case 'cleanup_failed':
      return withDetail('The test event was not removed', facts.detail);
    case 'cleanup_refused':
      return withDetail('Found an event that is not ours, removal cancelled', facts.detail);
    case 'api_garage_query_failed':
      return withDetail('Hawk rejected a query that the Garage web client sends', facts.detail);
    case 'field_not_masked':
      return join(`Event field ${facts.field ?? 'value'} was stored unmasked`, [': got ', facts.actual], ['; expected [filtered]', '']);
    case 'threshold_early':
      return withDetail('The threshold notification arrived before the event was repeated', facts.detail);
    case 'new_token_not_accepted':
      return join('The collector did not accept the token of the new project', [' within ', ifSet(facts.waitedMs, formatDuration)], [': ', facts.detail]);
    case 'release_rejected':
      return join('The collector rejected the release upload', [': HTTP ', ifSet(facts.status, String)], [' ', facts.detail]);
    case 'release_not_saved':
      return join('The release files were not saved', [' within ', ifSet(facts.waitedMs, formatDuration)], [': ', facts.detail]);
    case 'sourcemap_not_applied':
      return join(`The source map was not applied: ${facts.field ?? 'the frame'}`, [' expected ', facts.expected], [', got ', facts.actual]);
    case 'sentry_rejected':
      return join('The collector rejected the Sentry envelope', [': HTTP ', ifSet(facts.status, String)], [' ', facts.detail]);
    case 'monitor_internal':
      return join('Internal monitor error', [': ', facts.detail], [' (', ifSet(facts.cause, text => `${text})`)]);
    case 'run_timeout':
      return facts.detail === 'cancelled'
        ? 'The run was cancelled'
        : join('The run did not finish', [' within ', ifSet(facts.waitedMs, formatDuration)]);
    case 'tunnel_unavailable':
      return withDetail('Tunnel gave no working public address', facts.detail);
    case 'receiver_unreachable':
      return withDetail('Receiver is not reachable at the public address', facts.detail);
    case 'notification_endpoint_rejected':
      return withDetail(`Hawk rejected the address of ${ifSet(facts.channel, name => `the ${name}`) ?? 'a notification'} channel`, facts.detail);
    case 'provisioning_conflict':
      return withDetail('The notification rule is being changed in parallel', facts.detail);
    case 'provisioning_unstable':
      return withDetail('The notification rule is changed again on every run', facts.detail);
    case 'notification_timeout':
      return notificationTimeoutText(facts);
    case 'notification_mismatch':
      return join(`Notification differs from the event: ${facts.field ?? 'a field'}`,
        [' expected ', facts.expected], [', got ', facts.actual]);
    case 'duplicate_notification':
      return join(ifSet(facts.channel, name => `The ${name} notification arrived`) ?? 'The notification arrived',
        [' ', ifSet(facts.count, count => `${String(count)} times`) ?? 'more than once']);
    case 'run_hung':
      return join('The run did not finish', [' within ', ifSet(facts.waitedMs, formatDuration)], [' and was abandoned', '']);
    case 'monitor_restarted':
      return 'The monitor restarted while the run was in progress';
    case 'monitor_stopped':
      return 'The monitor stopped while the run was in progress';
    case 'alert_rejected':
      return join('codex.bot did not accept the alert', [': ', ifSet(facts.status, String)], [' ', facts.detail]);
  }
}
