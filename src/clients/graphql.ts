import { CheckError } from '../errors/taxonomy.js';
import { NetworkError, networkFailureToCheckError, requestWithRetry } from '../net/http.js';
import type { HttpResponse } from '../net/http.js';
import type { Clock } from '../time/clock.js';

const ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 200;
const SECOND_RETRY_DELAY_MS = 500;
const DEFAULT_RETRY_DELAYS_MS = [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS] as const;
const HTTP_SERVER_ERROR = 500;
const HTTP_BAD_REQUEST = 400;
const JSON_HEADERS = Object.fromEntries([['content-type', 'application/json']]);
const AUTH_CODES = new Set(['UNAUTHENTICATED', 'ACCESS_TOKEN_EXPIRED_ERROR', 'SSO_REQUIRED']);
const REJECTED_CODES = new Set(['GRAPHQL_VALIDATION_FAILED', 'BAD_USER_INPUT']);

/** One GraphQL document with its name. */
export interface GraphqlOperation {
  /** Operation name, also sent as `operationName`. */
  name: string;
  /** Query text. */
  document: string;
  /** True when sending it twice does no harm. */
  idempotent: boolean;
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
  /** Waits between attempts, `[200, 500]` by default. */
  retryDelaysMs?: readonly number[];
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
 * Creates a transport.
 * @param options Where to send, how long to wait and how to retry.
 * @returns Transport bound to one endpoint.
 */
export function createGraphqlTransport(options: GraphqlTransportOptions): GraphqlTransport {
  const { url, httpTimeoutMs, clock } = options;
  const delaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

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
        signal }, 'api', { attempts: operation.idempotent ? ATTEMPTS : 1,
        delaysMs,
        clock,
        retryStatus: status => operation.idempotent && status >= HTTP_SERVER_ERROR,
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

      if (response.status >= HTTP_SERVER_ERROR || !body) {
        throw new CheckError('api_unavailable', { url,
          status: response.status,
          waitedMs });
      }

      const first = Array.isArray(body.errors) ? (body.errors as (GraphqlErrorItem | undefined)[])[0] : undefined;
      const message = typeof first?.message === 'string' ? first.message : '';
      const code = typeof first?.extensions?.code === 'string' ? first.extensions.code : '';

      if (response.status === HTTP_BAD_REQUEST) {
        throw new CheckError('api_query_rejected', { url,
          status: response.status,
          detail: message || undefined });
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

        throw new CheckError(REJECTED_CODES.has(code) ? 'api_query_rejected' : 'api_error', { url,
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
