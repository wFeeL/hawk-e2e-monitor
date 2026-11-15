import { Buffer } from 'node:buffer';
import { CheckError } from '../errors/taxonomy.js';
import type { ErrorClass, MessageFacts } from '../errors/taxonomy.js';
import { stripTokenSecret } from '../errors/redact.js';
import type { CollectorEndpoints } from '../hawk/token.js';
import { NetworkError, networkFailureToCheckError, requestWithRetry } from '../net/http.js';
import { withRetry } from '../net/retry.js';
import { sendOverWebSocket } from '../net/ws.js';
import type { WsOutcome } from '../net/ws.js';
import type { Clock } from '../time/clock.js';
import { TOKEN_INVALID_PREFIX } from '../errors/redact.js';
import { HttpStatus } from '../net/http-status.js';
import { JSON_HEADERS } from '../net/http.js';

const ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 200;
const SECOND_RETRY_DELAY_MS = 500;
const DEFAULT_RETRY_DELAYS_MS = [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS] as const;
const SNIPPET_LENGTH = 200;
const PROBE_ID = '00000000-0000-4000-8000-000000000000';

/** How an event travels to the collector. */
export type Transport = 'http' | 'ws';

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
}

/** Inputs of the collector client. */
export interface CollectorClientOptions {
  /** Collector addresses. */
  endpoints: CollectorEndpoints;
  /** Deadline of one HTTP request or WebSocket exchange. */
  httpTimeoutMs: number;
  /** Clock for waits and durations. */
  clock: Clock;
  /** Waits between attempts, `[200, 500]` by default. */
  retryDelaysMs?: readonly number[];
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
 * Describes a body that carries no message.
 * @param status HTTP status.
 * @param body Body text.
 * @returns Status and the start of the body.
 */
function snippet(status: number, body: string): string {
  return `HTTP ${String(status)} ${body.slice(0, SNIPPET_LENGTH)}`.trimEnd();
}

/**
 * Sorts an answer of the collector (HTTP body or WebSocket frame) into accepted or a class.
 * Statuses 5xx are for the caller to judge.
 * @param status HTTP status, or the `code` of a WebSocket answer.
 * @param body Body text.
 * @returns Accepted, or the class and a message free of secrets.
 */
export function classifyCollectorReply(status: number, body: string): ReplyVerdict {
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
      return reject('bad_request', snippet(status, body));
    case HttpStatus.payloadTooLarge:
      return reject('payload_too_large', snippet(status, body));
    case HttpStatus.tooManyRequests:
      return reject('ip_blacklisted', snippet(status, body));
    default:
      return unexpected();
  }
}

/**
 * Builds the client of the collector.
 * @param options Addresses, timeout, clock and retry delays.
 * @returns Client with `health`, `probeInvalidToken` and `send`.
 */
export function createCollectorClient(options: CollectorClientOptions): CollectorClient {
  const { endpoints, httpTimeoutMs, clock } = options;
  const delaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

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
      }, { attempts: ATTEMPTS,
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
   * Builds the error of a WebSocket that never opened or never started.
   * @param outcome Outcome with its detail.
   * @returns `ws_handshake_failed` error.
   */
  const handshakeError = (outcome: WsOutcome): CheckError => new CheckError('ws_handshake_failed', { url: endpoints.wsUrl,
    ...outcome.kind === 'handshake_failed' ? { detail: outcome.detail } : {} });

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
        signal }, 'collector', { attempts: ATTEMPTS,
        delaysMs,
        clock,
        retryStatus: (status, text) => status >= HttpStatus.internalServerError && parseObject(text) === undefined,
        retryNetwork: () => true });
    } catch (error) {
      if (error instanceof NetworkError) {
        throw networkFailureToCheckError(error, facts());
      }

      throw error;
    }

    const { status, text } = result.response;
    const json = parseObject(text);

    if (json && (status === HttpStatus.ok || status >= HttpStatus.internalServerError)) {
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
      detail: text.slice(0, SNIPPET_LENGTH) });
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
        detail: stripTokenSecret(json && typeof json.message === 'string' ? json.message : outcome.text.slice(0, SNIPPET_LENGTH)) });
    }

    if (outcome.kind === 'handshake_failed') {
      throw handshakeError(outcome);
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
        signal }, 'collector', { attempts: ATTEMPTS,
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

    const verdict = classifyCollectorReply(response.status, response.text);

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
        error: handshakeError(outcome),
        attempts };
    }

    if (outcome.kind === 'closed' || outcome.kind === 'timeout') {
      return outcome.sent
        ? { kind: 'uncertain',
            cause: wsUnavailable(outcome, startedMs),
            attempts }
        : { kind: 'rejected',
            error: handshakeError(outcome),
            attempts };
    }

    const json = parseObject(outcome.text);

    if (typeof json?.code !== 'number') {
      return { kind: 'rejected',
        error: new CheckError('collector_unexpected_response', { url: endpoints.wsUrl,
          detail: outcome.text.slice(0, SNIPPET_LENGTH) }),
        attempts };
    }

    const verdict = classifyCollectorReply(json.code, outcome.text);

    return verdict.kind === 'accepted'
      ? { kind: 'accepted',
          attempts }
      : { kind: 'rejected',
          error: new CheckError(verdict.errorClass, { url: endpoints.wsUrl,
            detail: verdict.message }),
          attempts };
  };

  return { health,
    probeInvalidToken,
    send: async (message, transport, signal) => transport === 'http' ? sendHttp(message, signal) : sendWs(message, signal) };
}
