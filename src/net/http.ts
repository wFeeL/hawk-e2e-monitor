import { Buffer } from 'node:buffer';
import { CheckError } from '../errors/taxonomy.js';
import type { MessageFacts } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import { classifyNetworkError, unavailableClass } from './classify.js';
import type { NetTarget, NetworkFailure } from './classify.js';
import { withRetry } from './retry.js';

/** Headers for a JSON body. */
export const JSON_HEADERS: Readonly<Record<string, string>> = Object.fromEntries([['content-type', 'application/json']]);

/** A request made by `httpRequest`. */
export interface HttpRequest {
  /** Address. */
  url: string;
  /** Method. */
  method: 'GET' | 'POST';
  /** Extra headers. */
  headers?: Readonly<Record<string, string>>;
  /** Body of a POST; a form is sent as multipart with its own content type. */
  body?: FormData | string;
  /** Deadline of the whole request, body included. */
  timeoutMs: number;
  /** Reads at most this many bytes of the body and cancels the rest; the whole body when absent. */
  maxBytes?: number;
  /** Caller's abort signal. */
  signal: AbortSignal;
}

/** An answer of any status. */
export interface HttpResponse {
  /** HTTP status. */
  status: number;
  /** `content-type` header, empty when absent. */
  contentType: string;
  /** Body text; cut at `maxBytes` of the request when it had one. */
  text: string;
  /** True when the body was longer than `maxBytes` and the rest was dropped. */
  truncated: boolean;
}

/** Attempts, delays and rules for `requestWithRetry`. */
export interface RequestRetryOptions {
  /** Total attempts. */
  attempts: number;
  /** Waits between attempts. */
  delaysMs: readonly number[];
  /** Clock used for waiting. */
  clock: Clock;
  /** Tells whether a status, judged with the body text, deserves another attempt. */
  retryStatus: (status: number, text: string) => boolean;
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
  /** Attempts made when `requestWithRetry` gave up; 1 for a bare `httpRequest`. */
  public attempts = 1;

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

/** The start of a body and whether more followed. */
interface BodyStart {
  /** The bytes read, decoded as UTF-8; a character cut at the end becomes a replacement character. */
  text: string;
  /** True when the body was longer than the limit. */
  truncated: boolean;
}

/**
 * Reads the start of a body and cancels the rest.
 * @param response Answer whose body is read.
 * @param maxBytes Most bytes to read.
 * @returns The start of the body and whether it was cut.
 */
async function readStart(response: Response, maxBytes: number): Promise<BodyStart> {
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;

  let truncated = false;

  if (reader === undefined) {
    return { text: '',
      truncated };
  }

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    total += value.byteLength;

    if (total > maxBytes) {
      truncated = true;
      break;
    }
  }

  await reader.cancel();

  return { text: Buffer.concat(chunks).subarray(0, maxBytes)
    .toString('utf8'),
  truncated };
}

/**
 * Sends one request; the status is left to the caller.
 * @param request Request with its own deadline and signal.
 * @param target Which side is called, for classification.
 * @returns Status, content type and body text.
 * @throws NetworkError on any failure of the request or of the body read.
 */
export async function httpRequest(request: HttpRequest, target: NetTarget): Promise<HttpResponse> {
  // A real timer on purpose: tests move a fake clock in steps longer than a request timeout while the socket still answers.
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
    const body = request.maxBytes === undefined
      ? { text: await response.text(),
          truncated: false }
      : await readStart(response, request.maxBytes);

    return { status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: body.text,
      truncated: body.truncated };
  } catch (error) {
    // An abort reason may be any value, so an aborted signal always means a timeout.
    const failure: NetworkFailure = request.signal.aborted
      ? { errorClass: unavailableClass(target),
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

  return new CheckError(error.failure.errorClass, merged, { cause: error,
    ...error.failure.culprit === undefined ? {} : { culprit: error.failure.culprit } });
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

      if (options.retryStatus(response.status, response.text)) {
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

    if (error instanceof NetworkError) {
      error.attempts = made;
    }

    throw error;
  }
}
