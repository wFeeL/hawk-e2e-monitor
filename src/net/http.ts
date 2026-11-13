import { CheckError } from '../errors/taxonomy.js';
import type { MessageFacts } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import { classifyNetworkError } from './classify.js';
import type { NetTarget, NetworkFailure } from './classify.js';
import { withRetry } from './retry.js';

/** A request made by `httpRequest`. */
export interface HttpRequest {
  /** Address. */
  url: string;
  /** Method. */
  method: 'GET' | 'POST';
  /** Extra headers. */
  headers?: Readonly<Record<string, string>>;
  /** Body of a POST. */
  body?: string;
  /** Deadline of the whole request, body included. */
  timeoutMs: number;
  /** Caller's abort signal. */
  signal: AbortSignal;
}

/** An answer of any status. */
export interface HttpResponse {
  /** HTTP status. */
  status: number;
  /** `content-type` header, empty when absent. */
  contentType: string;
  /** Body text. */
  text: string;
}

/** Attempts, delays and rules for `requestWithRetry`. */
export interface RequestRetryOptions {
  /** Total attempts. */
  attempts: number;
  /** Waits between attempts. */
  delaysMs: readonly number[];
  /** Clock used for waiting. */
  clock: Clock;
  /** Tells whether a status deserves another attempt. */
  retryStatus: (status: number) => boolean;
  /** Tells whether a network failure deserves another attempt. */
  retryNetwork: (failure: NetworkFailure) => boolean;
}

/** Answer after retries. */
export interface RetriedResponse {
  /** The last answer. */
  response: HttpResponse;
  /** Attempts made. */
  attempts: number;
}

/** A request that failed on the network. */
export class NetworkError extends Error {
  public readonly failure: NetworkFailure;

  /**
   * Creates the error.
   * @param failure Classified failure.
   * @param options The original error as `cause`.
   */
  constructor(failure: NetworkFailure, options: ErrorOptions) {
    super(failure.code, options);
    this.name = 'NetworkError';
    this.failure = failure;
  }
}

/** Carries a retryable answer through `withRetry`. */
class HttpStatusError extends Error {
  public readonly response: HttpResponse;

  /**
   * Creates the error.
   * @param response Answer with a retryable status.
   */
  constructor(response: HttpResponse) {
    super(`HTTP ${String(response.status)}`);
    this.name = 'HttpStatusError';
    this.response = response;
  }
}

/**
 * Sends one request; the status is left to the caller.
 * @param request Request with its own deadline and signal.
 * @param target Which side is called, for classification.
 * @returns Status, content type and body text.
 * @throws NetworkError on any failure of the request or of the body read.
 */
export async function httpRequest(request: HttpRequest, target: NetTarget): Promise<HttpResponse> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);

  try {
    const init: RequestInit = { method: request.method,
      redirect: 'manual',
      signal };

    if (request.headers) {
      init.headers = { ...request.headers };
    }

    if (request.body !== undefined) {
      init.body = request.body;
    }

    const response = await fetch(request.url, init);
    const text = await response.text();

    return { status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text };
  } catch (error) {
    // An abort reason may be any value, so an aborted signal always means a timeout.
    const failure: NetworkFailure = request.signal.aborted
      ? { errorClass: target === 'collector' ? 'collector_unavailable' : 'api_unavailable',
          code: 'TIMEOUT',
          beforeSend: false }
      : classifyNetworkError(error, target);

    throw new NetworkError(failure, { cause: error });
  }
}

/**
 * Turns a network error into a taxonomy error.
 * @param error Error of `httpRequest`.
 * @param facts Facts known to the caller, such as `url` and `waitedMs`.
 * @returns CheckError of the failure's class with `code` and `host` filled in.
 */
export function networkFailureToCheckError(error: NetworkError, facts: MessageFacts): CheckError {
  const merged: MessageFacts = { ...facts,
    code: error.failure.code };

  if (merged.host === undefined && facts.url !== undefined) {
    const host = URL.canParse(facts.url) ? new URL(facts.url).hostname : '';

    if (host !== '') {
      merged.host = host;
    }
  }

  return new CheckError(error.failure.errorClass, merged, { cause: error });
}

/**
 * Sends a request and repeats it on retryable statuses and network failures.
 * @param request Request; its signal also cuts the waits.
 * @param target Which side is called.
 * @param options Attempts, delays and retry rules.
 * @returns The last answer (also when still retryable) and the attempts made.
 * @throws NetworkError when the last attempt failed on the network.
 */
export async function requestWithRetry(
  request: HttpRequest,
  target: NetTarget,
  options: RequestRetryOptions
): Promise<RetriedResponse> {
  let made = 0;

  try {
    const { value } = await withRetry(async () => {
      made += 1;

      const response = await httpRequest(request, target);

      if (options.retryStatus(response.status)) {
        throw new HttpStatusError(response);
      }

      return response;
    }, { attempts: options.attempts,
      delaysMs: options.delaysMs,
      clock: options.clock,
      signal: request.signal,
      shouldRetry: error => error instanceof HttpStatusError
        || (error instanceof NetworkError && options.retryNetwork(error.failure)) });

    return { response: value,
      attempts: made };
  } catch (error) {
    if (error instanceof HttpStatusError) {
      return { response: error.response,
        attempts: made };
    }

    throw error;
  }
}
