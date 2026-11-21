import { Buffer } from 'node:buffer';
import { COLLECTOR_PANIC_DETAIL } from '../errors/messages.js';
import { CheckError } from '../errors/taxonomy.js';
import type { ErrorClass, MessageFacts } from '../errors/taxonomy.js';
import { createRedactor, stripTokenSecret } from '../errors/redact.js';
import type { Redactor } from '../errors/redact.js';
import { decodeIntegrationToken, tokenKey } from '../hawk/token.js';
import type { CollectorEndpoints } from '../hawk/token.js';
import { JSON_HEADERS, NetworkError, networkFailureToCheckError, requestWithRetry } from '../net/http.js';
import { withRetry } from '../net/retry.js';
import type { RetryPolicy } from '../net/retry.js';
import { sendOverWebSocket } from '../net/ws.js';
import type { WsOutcome } from '../net/ws.js';
import type { Clock } from '../time/clock.js';
import { TOKEN_INVALID_PREFIX } from '../errors/redact.js';
import { HttpStatus } from '../net/http-status.js';

const SNIPPET_LENGTH = 200;

/** Largest collector answer the client reads (64 KiB); its answers are a few hundred bytes. */
export const MAX_COLLECTOR_BODY_BYTES = 65_536;
/** Classes of a health failure that explain a socket that did not open better than the handshake error does. */
const HEALTH_CLASSES_REPLACING_HANDSHAKE: readonly ErrorClass[] = ['collector_unavailable', 'dns_error', 'tls_error', 'network_error'];
const TOO_LARGE_DETAIL = `response larger than ${String(MAX_COLLECTOR_BODY_BYTES)} bytes`;
const PROBE_ID = '00000000-0000-4000-8000-000000000000';

/** Ways an event can travel to the collector. */
export const TRANSPORTS = ['http', 'ws'] as const;

/** How an event travels to the collector. */
export type Transport = (typeof TRANSPORTS)[number];

/** The body a Hawk SDK sends. */
export interface CollectorMessage {
  /** Integration token. */
  token: string;
  /** Catcher type, such as `errors/nodejs`. */
  catcherType: string;
  /** Event payload. */
  payload: Readonly<Record<string, unknown>>;
}

/** The collector confirmed the event. */
export interface SendAccepted {
  /** Discriminator. */
  kind: 'accepted';
  /** Attempts made. */
  attempts: number;
}

/** The event was certainly not accepted. */
export interface SendRejected {
  /** Discriminator. */
  kind: 'rejected';
  /** Why. */
  error: CheckError;
  /** Attempts made. */
  attempts: number;
}

/** The event may or may not have reached the collector. */
export interface SendUncertain {
  /** Discriminator. */
  kind: 'uncertain';
  /** What went wrong after the send; the class is `collector_unavailable`. */
  cause: CheckError;
  /** Attempts made. */
  attempts: number;
}

/** Result of `send`. */
export type SendOutcome = SendAccepted | SendRejected | SendUncertain;

/** Talks to the Hawk collector. */
export interface CollectorClient {
  /**
   * Checks `/health`.
   * @param signal Aborts the check.
   * @returns Resolves when both flags are true.
   * @throws CheckError on any failure.
   */
  health(signal: AbortSignal): Promise<void>;
  /**
   * Sends a message with a token that does not exist over WebSocket and expects the 400 answer.
   * @param signal Aborts the probe.
   * @returns Resolves when the collector answered as expected.
   * @throws CheckError on any failure.
   */
  probeInvalidToken(signal: AbortSignal): Promise<void>;
  /**
   * Sends one event.
   * @param message Event message.
   * @param transport HTTP or WebSocket.
   * @param signal Aborts the send.
   * @returns Whether the collector took the event.
   */
  send(message: CollectorMessage, transport: Transport, signal: AbortSignal): Promise<SendOutcome>;
  /**
   * Uploads a release with one source map file.
   * A 200 only means the collector published it; the file shows up in Hawk later.
   * @param token Integration token of the project, sent as a bearer.
   * @param release Release name.
   * @param file Source map file.
   * @param signal Aborts the upload.
   * @returns Whether the collector took the release; a refusal that is not a known class is `release_rejected`.
   */
  uploadRelease(token: string, release: string, file: ReleaseFile, signal: AbortSignal): Promise<SendOutcome>;
  /**
   * Posts a Sentry envelope to the collector.
   * A 200 says nothing about the event: an envelope with no event gets it too.
   * @param sentryKey Key of the integration token without dashes, which goes into the address.
   * @param body Envelope text.
   * @param signal Aborts the request.
   * @returns Whether the collector took the envelope; a refusal that is not a known class is `sentry_rejected`.
   */
  sendEnvelope(sentryKey: string, body: string, signal: AbortSignal): Promise<SendOutcome>;
}

/** A source map file to upload with a release. */
export interface ReleaseFile {
  /** Name of the file, such as `bundle.js.map`. */
  name: string;
  /** Text of the file. */
  content: string;
}

/** Inputs of the collector client. */
export interface CollectorClientOptions {
  /** Collector addresses. */
  endpoints: CollectorEndpoints;
  /** Deadline of one HTTP request or WebSocket exchange. */
  httpTimeoutMs: number;
  /** Clock for waits and durations. */
  clock: Clock;
  /** Attempts and waits between them. */
  retry: RetryPolicy;
}

/** The collector took the message. */
export interface ReplyAccepted {
  /** Discriminator. */
  kind: 'accepted';
}

/** The collector refused the message. */
export interface ReplyRejected {
  /** Discriminator. */
  kind: 'rejected';
  /** Taxonomy class. */
  errorClass: ErrorClass;
  /** Text without secrets. */
  message: string;
}

/** Verdict on a collector answer. */
export type ReplyVerdict = ReplyAccepted | ReplyRejected;

/** Token that no project owns, for the probe. */
export const PROBE_TOKEN: string = Buffer.from(JSON.stringify({ integrationId: PROBE_ID,
  secret: PROBE_ID })).toString('base64');

/** Outcome of a WebSocket exchange after retries. */
interface ExchangeResult {
  /** Outcome of the last attempt. */
  outcome: WsOutcome;
  /** Attempts made. */
  attempts: number;
}

/** Failed WebSocket handshake, thrown inside `withRetry` so it is repeated. */
class HandshakeFailure extends Error {
  public readonly outcome: WsOutcome;

  /**
   * Creates the error.
   * @param outcome The failed handshake.
   */
  constructor(outcome: WsOutcome) {
    super('handshake failed');
    this.name = 'HandshakeFailure';
    this.outcome = outcome;
  }
}

/** A parsed answer; the collector's keys are not ours to rename. */
type ReplyBody = Record<string, unknown>;

/**
 * Parses a JSON object.
 * @param text Body text.
 * @returns The object, or undefined for anything else.
 */
function parseObject(text: string): ReplyBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as ReplyBody : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the redactor for the answers to a call made with a token.
 * The client is given no secrets at creation, so each call masks the ones it carries before any text is cut to a snippet.
 * @param token Base64 integration token, or the Sentry key that is `tokenKey` of it.
 * @returns Redactor for the token, its secret and its collector key.
 */
function redactorFor(token: string): Redactor {
  const decoded = decodeIntegrationToken(token);

  return createRedactor(decoded === undefined ? [token] : [token, decoded.secret, tokenKey(decoded)]);
}

/**
 * Tells the health answer of the collector from the page of a proxy: the collector always sends its flags as booleans.
 * @param json Parsed body, if it was an object.
 * @returns True when at least one known flag is a boolean.
 */
function isHealthShape(json: ReplyBody | undefined): boolean {
  return json !== undefined && (typeof json.redis_status === 'boolean' || typeof json.mongo_db_status === 'boolean');
}

/**
 * Turns a body into one short line: tags dropped, whitespace collapsed.
 * @param text Body text, possibly HTML with line breaks.
 * @returns At most `SNIPPET_LENGTH` characters on one line.
 */
function flatSnippet(text: string): string {
  return text
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, SNIPPET_LENGTH);
}

/**
 * Describes a body that carries no message.
 * @param status HTTP status.
 * @param body Body text.
 * @returns Status and the start of the body.
 */
function snippet(status: number, body: string): string {
  return `HTTP ${String(status)} ${flatSnippet(body)}`.trimEnd();
}

/**
 * Tells the answer of the collector's panic recovery from the 400 page of a proxy.
 * @param status HTTP status.
 * @param body Body text.
 * @returns True for a 400 whose body is exactly `Bad request`.
 */
function isHandlerPanic(status: number, body: string): boolean {
  // A panic inside the collector answers plain-text 400; handler answers are always JSON.
  return status === HttpStatus.badRequest && body.trim() === 'Bad request';
}

/**
 * Sorts an answer of the collector (HTTP body or WebSocket frame) into accepted or a class.
 * Statuses 5xx are for the caller to judge.
 * @param status HTTP status, or the `code` of a WebSocket answer.
 * @param body Body text.
 * @param truncated True when the body was longer than the read limit.
 * @returns Accepted, or the class and a message free of secrets.
 */
export function classifyCollectorReply(status: number, body: string, truncated = false): ReplyVerdict {
  if (truncated) {
    return { kind: 'rejected',
      errorClass: 'collector_unexpected_response',
      message: TOO_LARGE_DETAIL };
  }

  const json = parseObject(body);
  const reject = (errorClass: ErrorClass, message: string): ReplyRejected => ({ kind: 'rejected',
    errorClass,
    message });
  const unexpected = (): ReplyRejected => reject('collector_unexpected_response',
    typeof json?.message === 'string' ? stripTokenSecret(json.message) : snippet(status, body));

  if (status === HttpStatus.ok) {
    return json?.error === false ? { kind: 'accepted' } : unexpected();
  }

  if (json) {
    const text = typeof json.message === 'string' ? stripTokenSecret(json.message) : undefined;
    const message = text ?? snippet(status, body);

    if (status === HttpStatus.badRequest) {
      if (text?.startsWith(TOKEN_INVALID_PREFIX) === true) {
        return reject('auth_invalid_token', text);
      }

      return reject(text === 'Request is too large' ? 'payload_too_large' : 'bad_request', message);
    }

    if (status === HttpStatus.paymentRequired) {
      switch (text) {
        case 'Project has exceeded the events limit':
          return reject('quota_exhausted', message);
        case 'Rate limit exceeded':
          return reject('rate_limited', message);
        case 'Failed to update rate limit':
          return reject('collector_dependency_error', message);
        default:
          return reject('unknown_402', message);
      }
    }

    return unexpected();
  }

  switch (status) {
    case HttpStatus.badRequest:
      return reject('collector_unexpected_response', isHandlerPanic(status, body) ? COLLECTOR_PANIC_DETAIL : snippet(status, body));
    case HttpStatus.payloadTooLarge:
      return reject('payload_too_large', snippet(status, body));
    case HttpStatus.tooManyRequests:
      return reject('ip_blacklisted', snippet(status, body));
    default:
      return unexpected();
  }
}

/**
 * Turns the refusal of a collector endpoint into a taxonomy error.
 * The classes of an event refusal that mean the same for any endpoint stay; the rest says only that this endpoint refused.
 * @param verdict Rejected verdict of `classifyCollectorReply`.
 * @param url Address of the endpoint, without a secret.
 * @param status HTTP status of the answer.
 * @param fallback Class for a refusal that has no class of its own.
 * @returns Error with the class, the status and the text of the collector.
 */
function refusalOf(verdict: ReplyRejected, url: string, status: number, fallback: ErrorClass): CheckError {
  const keeps: readonly ErrorClass[] = ['auth_invalid_token', 'quota_exhausted', 'rate_limited', 'unknown_402', 'collector_dependency_error', 'ip_blacklisted'];
  // A handler that panicked answers a plain 400, and an oversized body is no answer either; neither says anything about the release or the envelope.
  const panic = verdict.errorClass === 'collector_unexpected_response'
    && (verdict.message === COLLECTOR_PANIC_DETAIL || verdict.message === TOO_LARGE_DETAIL);

  return new CheckError(panic || keeps.includes(verdict.errorClass) ? verdict.errorClass : fallback, { url,
    status,
    detail: verdict.message });
}

/**
 * Builds the client of the collector.
 * @param options Addresses, timeout, clock and retry policy.
 * @returns Client with `health`, `probeInvalidToken` and `send`.
 */
export function createCollectorClient(options: CollectorClientOptions): CollectorClient {
  const { endpoints, httpTimeoutMs, clock } = options;
  const { attempts: maxAttempts, delaysMs } = options.retry;

  /**
   * Opens a socket per attempt; a failed handshake is tried again.
   * @param text Message to send.
   * @param signal Aborts the exchange and the waits.
   * @returns Outcome of the last attempt and the attempts made.
   */
  const exchange = async (text: string, signal: AbortSignal): Promise<ExchangeResult> => {
    let made = 0;

    try {
      const { value } = await withRetry(async () => {
        made += 1;

        const outcome = await sendOverWebSocket(endpoints.wsUrl, text, { timeoutMs: httpTimeoutMs,
          signal });

        if (outcome.kind === 'handshake_failed') {
          throw new HandshakeFailure(outcome);
        }

        return outcome;
      }, { attempts: maxAttempts,
        delaysMs,
        clock,
        signal,
        shouldRetry: error => error instanceof HandshakeFailure });

      return { outcome: value,
        attempts: made };
    } catch (error) {
      if (error instanceof HandshakeFailure) {
        return { outcome: error.outcome,
          attempts: made };
      }

      throw error;
    }
  };

  /**
   * Builds the error for a WebSocket that closed or timed out.
   * @param outcome Closed or timed-out outcome.
   * @param startedMs Start of the exchange on the monotonic clock.
   * @returns `collector_unavailable` error.
   */
  const wsUnavailable = (outcome: WsOutcome, startedMs: number): CheckError => new CheckError('collector_unavailable',
    { url: endpoints.wsUrl,
      code: outcome.kind === 'closed' ? 'WS_CLOSED' : 'TIMEOUT',
      waitedMs: Math.round(clock.monotonicMs() - startedMs) });

  const health = async (signal: AbortSignal): Promise<void> => {
    const startedMs = clock.monotonicMs();
    const facts = (): MessageFacts => ({ url: endpoints.healthUrl,
      waitedMs: Math.round(clock.monotonicMs() - startedMs) });
    let result;

    try {
      result = await requestWithRetry({ url: endpoints.healthUrl,
        method: 'GET',
        timeoutMs: httpTimeoutMs,
        maxBytes: MAX_COLLECTOR_BODY_BYTES,
        signal }, 'collector', { attempts: maxAttempts,
        delaysMs,
        clock,
        retryStatus: (status, text) => status >= HttpStatus.internalServerError && !isHealthShape(parseObject(text)),
        retryNetwork: () => true });
    } catch (error) {
      if (error instanceof NetworkError) {
        throw networkFailureToCheckError(error, facts());
      }

      throw error;
    }

    const { status, text, truncated } = result.response;
    const json = parseObject(text);

    if (truncated && status < HttpStatus.internalServerError) {
      throw new CheckError('collector_unexpected_response', { ...facts(),
        status,
        detail: TOO_LARGE_DETAIL });
    }

    if (json && isHealthShape(json) && (status === HttpStatus.ok || status >= HttpStatus.internalServerError)) {
      if (status === HttpStatus.ok && json.redis_status === true && json.mongo_db_status === true) {
        return;
      }

      const flag = (value: unknown): string => typeof value === 'boolean' ? String(value) : 'missing';

      throw new CheckError('collector_dependency_error', { ...facts(),
        status,
        detail: `redis_status=${flag(json.redis_status)}, mongo_db_status=${flag(json.mongo_db_status)}` });
    }

    if (status >= HttpStatus.internalServerError) {
      throw new CheckError('collector_unavailable', { ...facts(),
        status });
    }

    // The blacklist is checked before routing, so `/health` answers 429 as well.
    const verdict = status === HttpStatus.tooManyRequests ? classifyCollectorReply(status, text) : undefined;

    if (verdict?.kind === 'rejected') {
      throw new CheckError(verdict.errorClass, { ...facts(),
        status,
        detail: verdict.message });
    }

    throw new CheckError('collector_unexpected_response', { ...facts(),
      status,
      detail: isHandlerPanic(status, text) ? COLLECTOR_PANIC_DETAIL : flatSnippet(text) });
  };

  /**
   * Builds the error of a WebSocket that never opened or never started.
   * The browser API hides why the socket failed, so one health request tells a collector that is down or unreachable from a proxy that refuses only the upgrade.
   * @param outcome Outcome with its detail.
   * @param startedMs Start of the exchange on the monotonic clock.
   * @param signal Aborts the health request.
   * @returns The network class of the health request when it failed that way, `ws_handshake_failed` otherwise.
   */
  const handshakeError = async (outcome: WsOutcome, startedMs: number, signal: AbortSignal): Promise<CheckError> => {
    const own = new CheckError('ws_handshake_failed', { url: endpoints.wsUrl,
      ...outcome.kind === 'handshake_failed' ? { detail: outcome.detail } : {},
      ...outcome.kind === 'timeout'
        ? { code: 'TIMEOUT',
            waitedMs: Math.round(clock.monotonicMs() - startedMs) }
        : {} });

    try {
      await health(signal);
    } catch (error) {
      if (error instanceof CheckError && HEALTH_CLASSES_REPLACING_HANDSHAKE.includes(error.errorClass)) {
        return error;
      }
    }

    return own;
  };

  const probeInvalidToken = async (signal: AbortSignal): Promise<void> => {
    const startedMs = clock.monotonicMs();
    const { outcome } = await exchange(JSON.stringify({ token: PROBE_TOKEN,
      catcherType: 'errors/javascript',
      payload: { title: 'hawk-e2e-monitor token probe' } }), signal);

    if (outcome.kind === 'response') {
      const json = parseObject(outcome.text);

      if (json?.code === HttpStatus.badRequest && typeof json.message === 'string' && json.message.startsWith(TOKEN_INVALID_PREFIX)) {
        return;
      }

      throw new CheckError('collector_unexpected_response', { url: endpoints.wsUrl,
        detail: stripTokenSecret(json && typeof json.message === 'string' ? json.message : flatSnippet(outcome.text)) });
    }

    if (outcome.kind === 'handshake_failed') {
      throw await handshakeError(outcome, startedMs, signal);
    }

    throw wsUnavailable(outcome, startedMs);
  };

  const sendHttp = async (message: CollectorMessage, signal: AbortSignal): Promise<SendOutcome> => {
    const startedMs = clock.monotonicMs();
    const facts = (): MessageFacts => ({ url: endpoints.postUrl,
      waitedMs: Math.round(clock.monotonicMs() - startedMs) });
    let result;

    try {
      result = await requestWithRetry({ url: endpoints.postUrl,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(message),
        timeoutMs: httpTimeoutMs,
        maxBytes: MAX_COLLECTOR_BODY_BYTES,
        signal }, 'collector', { attempts: maxAttempts,
        delaysMs,
        clock,
        retryStatus: () => false,
        retryNetwork: failure => failure.beforeSend });
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }

      const checkError = networkFailureToCheckError(error, facts());

      return error.failure.beforeSend
        ? { kind: 'rejected',
            error: checkError,
            attempts: error.attempts }
        : { kind: 'uncertain',
            cause: checkError,
            attempts: error.attempts };
    }

    const { response, attempts } = result;

    if (response.status >= HttpStatus.internalServerError) {
      return { kind: 'uncertain',
        cause: new CheckError('collector_unavailable', { ...facts(),
          status: response.status }),
        attempts };
    }

    const verdict = classifyCollectorReply(response.status, redactorFor(message.token)(response.text), response.truncated);

    return verdict.kind === 'accepted'
      ? { kind: 'accepted',
          attempts }
      : { kind: 'rejected',
          error: new CheckError(verdict.errorClass, { url: endpoints.postUrl,
            status: response.status,
            detail: verdict.message }),
          attempts };
  };

  const sendWs = async (message: CollectorMessage, signal: AbortSignal): Promise<SendOutcome> => {
    const startedMs = clock.monotonicMs();
    const { outcome, attempts } = await exchange(JSON.stringify(message), signal);

    if (outcome.kind === 'handshake_failed') {
      return { kind: 'rejected',
        error: await handshakeError(outcome, startedMs, signal),
        attempts };
    }

    if (outcome.kind === 'closed' || outcome.kind === 'timeout') {
      return outcome.sent
        ? { kind: 'uncertain',
            cause: wsUnavailable(outcome, startedMs),
            attempts }
        : { kind: 'rejected',
            error: await handshakeError(outcome, startedMs, signal),
            attempts };
    }

    const text = redactorFor(message.token)(outcome.text);
    const json = parseObject(text);

    if (typeof json?.code !== 'number') {
      return { kind: 'rejected',
        error: new CheckError('collector_unexpected_response', { url: endpoints.wsUrl,
          detail: flatSnippet(text) }),
        attempts };
    }

    const verdict = classifyCollectorReply(json.code, text);

    return verdict.kind === 'accepted'
      ? { kind: 'accepted',
          attempts }
      : { kind: 'rejected',
          error: new CheckError(verdict.errorClass, { url: endpoints.wsUrl,
            detail: verdict.message }),
          attempts };
  };

  const uploadRelease: CollectorClient['uploadRelease'] = async (token, release, file, signal) => {
    const startedMs = clock.monotonicMs();
    const facts = (): MessageFacts => ({ url: endpoints.releaseUrl,
      waitedMs: Math.round(clock.monotonicMs() - startedMs) });
    const form = new FormData();

    form.append('release', release);
    form.append('file', new Blob([file.content], { type: 'application/json' }), file.name);

    let result;

    try {
      result = await requestWithRetry({ url: endpoints.releaseUrl,
        method: 'POST',
        headers: Object.fromEntries([['authorization', `Bearer ${token}`]]),
        body: form,
        timeoutMs: httpTimeoutMs,
        maxBytes: MAX_COLLECTOR_BODY_BYTES,
        signal }, 'collector', { attempts: maxAttempts,
        delaysMs,
        clock,
        retryStatus: () => false,
        retryNetwork: failure => failure.beforeSend });
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }

      const checkError = networkFailureToCheckError(error, facts());

      return error.failure.beforeSend
        ? { kind: 'rejected',
            error: checkError,
            attempts: error.attempts }
        : { kind: 'uncertain',
            cause: checkError,
            attempts: error.attempts };
    }

    const { response, attempts } = result;

    if (response.status >= HttpStatus.internalServerError) {
      return { kind: 'uncertain',
        cause: new CheckError('collector_unavailable', { ...facts(),
          status: response.status }),
        attempts };
    }

    const verdict = classifyCollectorReply(response.status, redactorFor(token)(response.text), response.truncated);

    if (verdict.kind === 'accepted') {
      return { kind: 'accepted',
        attempts };
    }

    return { kind: 'rejected',
      error: refusalOf(verdict, endpoints.releaseUrl, response.status, 'release_rejected'),
      attempts };
  };

  const sendEnvelope: CollectorClient['sendEnvelope'] = async (sentryKey, body, signal) => {
    const startedMs = clock.monotonicMs();
    // The key is a secret and sits in the query, so the address in the facts is the one without it.
    const facts = (): MessageFacts => ({ url: endpoints.envelopeUrl,
      waitedMs: Math.round(clock.monotonicMs() - startedMs) });
    const url = new URL(endpoints.envelopeUrl);

    url.searchParams.set('sentry_key', sentryKey);

    let result;

    try {
      result = await requestWithRetry({ url: url.href,
        method: 'POST',
        headers: Object.fromEntries([['content-type', 'application/x-sentry-envelope']]),
        body,
        timeoutMs: httpTimeoutMs,
        maxBytes: MAX_COLLECTOR_BODY_BYTES,
        signal }, 'collector', { attempts: maxAttempts,
        delaysMs,
        clock,
        retryStatus: () => false,
        retryNetwork: failure => failure.beforeSend });
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }

      const checkError = networkFailureToCheckError(error, facts());

      return error.failure.beforeSend
        ? { kind: 'rejected',
            error: checkError,
            attempts: error.attempts }
        : { kind: 'uncertain',
            cause: checkError,
            attempts: error.attempts };
    }

    const { response, attempts } = result;

    if (response.status >= HttpStatus.internalServerError) {
      return { kind: 'uncertain',
        cause: new CheckError('collector_unavailable', { ...facts(),
          status: response.status }),
        attempts };
    }

    const verdict = classifyCollectorReply(response.status, redactorFor(sentryKey)(response.text), response.truncated);

    return verdict.kind === 'accepted'
      ? { kind: 'accepted',
          attempts }
      : { kind: 'rejected',
          error: refusalOf(verdict, endpoints.envelopeUrl, response.status, 'sentry_rejected'),
          attempts };
  };

  return { health,
    probeInvalidToken,
    uploadRelease,
    sendEnvelope,
    send: async (message, transport, signal) => transport === 'http' ? sendHttp(message, signal) : sendWs(message, signal) };
}
