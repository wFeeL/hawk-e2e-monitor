import { CheckError } from '../errors/taxonomy.js';
import { JSON_HEADERS, NetworkError, networkFailureToCheckError, requestWithRetry } from '../net/http.js';
import type { RetryPolicy } from '../net/retry.js';
import type { HttpResponse } from '../net/http.js';
import type { Clock } from '../time/clock.js';
import { HttpStatus } from '../net/http-status.js';

/** Hawk code for an expired access token. */
export const ACCESS_EXPIRED = 'ACCESS_TOKEN_EXPIRED_ERROR';
/** Hawk code for a missing or invalid login. */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';
/** Hawk code for an argument that failed its own validation or names something that does not exist. */
export const BAD_USER_INPUT = 'BAD_USER_INPUT';
/** Largest API answer the client reads (4 MiB); the rest of a longer body is dropped. */
export const MAX_API_BODY_BYTES = 4_194_304;

const AUTH_CODES = new Set([UNAUTHENTICATED, ACCESS_EXPIRED, 'SSO_REQUIRED']);
const LOGIN_OPERATION = 'Login';
const DOMAIN_MESSAGE_LENGTH = 200;
const REJECTED_CODES = new Set(['GRAPHQL_VALIDATION_FAILED', BAD_USER_INPUT]);

/** One GraphQL document with its name. */
export interface GraphqlOperation {
  /** Operation name, also sent as `operationName`. */
  name: string;
  /** Query text. */
  document: string;
  /** True when sending it twice does no harm. */
  idempotent: boolean;
  /** The document is one of the Garage web client; Hawk refusing it means Garage is broken for users. */
  garage?: boolean;
}

/** An error code the layer above decides on, such as an expired token. */
export class GraphqlFailure extends Error {
  public readonly code: string;

  /**
   * Creates the failure.
   * @param code `extensions.code` of the GraphQL error.
   * @param message Message of the GraphQL error.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GraphqlFailure';
    this.code = code;
  }
}

/** Sends GraphQL operations and turns failures into taxonomy errors. */
export interface GraphqlTransport {
  /**
   * Sends an operation.
   * @param operation Document and its retry safety.
   * @param variables Operation variables.
   * @param accessToken Bearer token, absent for anonymous operations.
   * @param signal Deadline of the caller.
   * @returns The `data` object.
   * @throws CheckError for network, HTTP and most GraphQL failures.
   * @throws GraphqlFailure for authentication codes.
   */
  request<T>(
    operation: GraphqlOperation,
    variables: Readonly<Record<string, unknown>>,
    accessToken: string | undefined,
    signal: AbortSignal
  ): Promise<T>;
}

/** Settings of a transport. */
export interface GraphqlTransportOptions {
  /** Full GraphQL address. */
  url: string;
  /** Deadline of one request. */
  httpTimeoutMs: number;
  /** Clock for waits between attempts and for `waitedMs`. */
  clock: Clock;
  /** Attempts and waits between them; only idempotent operations are repeated. */
  retry: RetryPolicy;
}

/** One element of the GraphQL `errors` array. */
interface GraphqlErrorItem {
  /** Error text. */
  message?: unknown;
  /** Extra fields of the error. */
  extensions?: GraphqlErrorExtensions;
}

/** Extensions of an element of `errors`. */
interface GraphqlErrorExtensions {
  /** Error code set by Apollo or by Hawk. */
  code?: unknown;
}

/** The part of a GraphQL response the transport reads. */
interface GraphqlBody {
  /** Result of the operation. */
  data?: unknown;
  /** Errors of the operation. */
  errors?: unknown;
}

/**
 * Parses a JSON object.
 * @param text Body text.
 * @returns The object, or undefined for anything else.
 */
function parseObject(text: string): GraphqlBody | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the error of a refused query.
 * `BAD_USER_INPUT` is a domain answer of Hawk, such as an unknown project, so it blames Hawk and shows the server's text; the other codes mean the monitor's query is wrong.
 * @param url API address.
 * @param status HTTP status.
 * @param code GraphQL code of the first error, empty when there is none.
 * @param message Message of the first error, empty when there is none.
 * @returns `api_query_rejected` error carrying the code.
 */
function queryRejected(url: string, status: number, code: string, message: string): CheckError {
  const facts = { url,
    status,
    ...code === '' ? {} : { code },
    detail: message === '' ? undefined : message.slice(0, DOMAIN_MESSAGE_LENGTH) };

  if (code === BAD_USER_INPUT && message !== '') {
    return new CheckError('api_query_rejected', facts, { culprit: 'hawk',
      message: message.slice(0, DOMAIN_MESSAGE_LENGTH) });
  }

  return new CheckError('api_query_rejected', facts, code === BAD_USER_INPUT ? { culprit: 'hawk' } : {});
}

/**
 * Tells a GraphQL answer from the page of a proxy that happens to be JSON.
 * @param body Parsed body, if it was an object.
 * @returns True when the body has `data` or `errors`.
 */
function isGraphqlAnswer(body: GraphqlBody | undefined): boolean {
  return body !== undefined && ('data' in body || 'errors' in body);
}

/**
 * Tells a passing fault from a final answer: a 5xx, or a 408 or 429 that is not a GraphQL answer.
 * A proxy or a rate limiter sends those as plain pages, and a repeat may succeed.
 * @param status HTTP status.
 * @param text Body text.
 * @returns True when the request may be repeated and the API counts as unavailable.
 */
function isTransient(status: number, text: string): boolean {
  return status >= HttpStatus.internalServerError
    || ((status === HttpStatus.requestTimeout || status === HttpStatus.tooManyRequests) && parseObject(text) === undefined);
}

/**
 * Creates a transport.
 * @param options Where to send, how long to wait and how to retry.
 * @returns Transport bound to one endpoint.
 */
export function createGraphqlTransport(options: GraphqlTransportOptions): GraphqlTransport {
  const { url, httpTimeoutMs, clock } = options;
  const { attempts, delaysMs } = options.retry;

  const send = async (
    operation: GraphqlOperation,
    variables: Readonly<Record<string, unknown>>,
    accessToken: string | undefined,
    signal: AbortSignal
  ): Promise<HttpResponse> => {
    const headers: Record<string, string> = { ...JSON_HEADERS };

    if (accessToken !== undefined) {
      headers.authorization = `Bearer ${accessToken}`;
    }

    const startedAt = clock.monotonicMs();

    try {
      const { response } = await requestWithRetry({ url,
        method: 'POST',
        headers,
        body: JSON.stringify({ operationName: operation.name,
          query: operation.document,
          variables }),
        timeoutMs: httpTimeoutMs,
        maxBytes: MAX_API_BODY_BYTES,
        signal }, 'api', { attempts: operation.idempotent ? attempts : 1,
        delaysMs,
        clock,
        retryStatus: (status, text) => operation.idempotent && isTransient(status, text),
        retryNetwork: () => operation.idempotent });

      return response;
    } catch (error) {
      if (error instanceof NetworkError) {
        throw networkFailureToCheckError(error, { url,
          waitedMs: Math.round(clock.monotonicMs() - startedAt) });
      }

      throw error;
    }
  };

  return {
    async request<T>(
      operation: GraphqlOperation,
      variables: Readonly<Record<string, unknown>>,
      accessToken: string | undefined,
      signal: AbortSignal
    ): Promise<T> {
      const startedAt = clock.monotonicMs();
      const response = await send(operation, variables, accessToken, signal);
      const waitedMs = Math.round(clock.monotonicMs() - startedAt);
      const body = parseObject(response.text);

      if (response.truncated) {
        throw new CheckError('api_unexpected_response', { url,
          status: response.status,
          detail: `response larger than ${String(MAX_API_BODY_BYTES)} bytes` });
      }

      const rateLimited = response.status === HttpStatus.tooManyRequests;

      if (isTransient(response.status, response.text) || (rateLimited && !isGraphqlAnswer(body))) {
        throw new CheckError('api_unavailable', { url,
          status: response.status,
          ...rateLimited ? { detail: 'rate limited (429)' } : {},
          waitedMs });
      }

      // A proxy or a firewall answers 401 or 403 with its own page; Hawk itself reports auth problems inside GraphQL answers.
      if (!isGraphqlAnswer(body) && (response.status === HttpStatus.unauthorized || response.status === HttpStatus.forbidden)) {
        throw new CheckError(operation.name === LOGIN_OPERATION ? 'api_auth_failed' : 'api_unavailable', { url,
          status: response.status,
          detail: `HTTP ${String(response.status)}`,
          waitedMs });
      }

      if (!body) {
        throw new CheckError('api_unexpected_response', { url,
          status: response.status,
          waitedMs });
      }

      const first = Array.isArray(body.errors) ? (body.errors as (GraphqlErrorItem | undefined)[])[0] : undefined;
      const message = typeof first?.message === 'string' ? first.message : '';
      const code = typeof first?.extensions?.code === 'string' ? first.extensions.code : '';

      // Apollo answers a document that fails validation with HTTP 400 and `errors[]`; for Garage documents the list says what is wrong.
      if (response.status === HttpStatus.badRequest && !(operation.garage === true && first)) {
        throw queryRejected(url, response.status, code, message);
      }

      if (first) {
        if (AUTH_CODES.has(code)) {
          throw new GraphqlFailure(code, message);
        }

        if (code === 'FORBIDDEN') {
          const { projectId } = variables;

          throw new CheckError('api_forbidden', { url,
            status: response.status,
            ...typeof projectId === 'string' ? { projectId } : {},
            detail: message });
        }

        if (operation.garage === true) {
          throw new CheckError('api_garage_query_failed', { url,
            status: response.status,
            detail: message });
        }

        if (REJECTED_CODES.has(code)) {
          throw queryRejected(url, response.status, code, message);
        }

        throw new CheckError('api_error', { url,
          status: response.status,
          detail: message });
      }

      if (typeof body.data !== 'object' || body.data === null) {
        throw new CheckError('api_error', { url,
          status: response.status,
          detail: 'response has no data' });
      }

      return body.data as T;
    },
  };
}
