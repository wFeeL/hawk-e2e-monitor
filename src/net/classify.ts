import type { ErrorClass } from '../errors/taxonomy.js';

const MAX_CHAIN_DEPTH = 8;
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/u;
const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);

/** Which side a request goes to. */
export type NetTarget = 'api' | 'collector' | 'heartbeat' | 'notify';

/**
 * Names the class of a request that got no usable answer.
 * @param target Which side was called.
 * @returns The `unavailable` class of Hawk's sides; a bot that is down is a network problem, not Hawk's.
 */
export function unavailableClass(target: NetTarget): ErrorClass {
  switch (target) {
    case 'collector':
      return 'collector_unavailable';
    case 'api':
      return 'api_unavailable';
    case 'heartbeat':
    case 'notify':
      return 'network_error';
  }
}

/** A network failure laid out for the taxonomy. */
export interface NetworkFailure {
  /** Taxonomy class. */
  errorClass: ErrorClass;
  /** Network code, `TIMEOUT`, `BAD_PORT` or `UNKNOWN`. */
  code: string;
  /** True when the request certainly did not reach the server. */
  beforeSend: boolean;
}

/** The parts of an error the classifier reads. */
interface ErrorLike {
  /** Next error in the chain. */
  cause?: unknown;
  /** Network or protocol code; numeric for DOMException. */
  code?: unknown;
}

/**
 * Lists an error and its causes.
 * @param error Outermost error.
 * @returns Chain, outermost first.
 */
function chainOf(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;

  while (current !== undefined && current !== null && chain.length < MAX_CHAIN_DEPTH) {
    chain.push(current);
    current = typeof current === 'object' ? (current as ErrorLike).cause : undefined;
  }

  return chain;
}

/**
 * Finds the first string `code` in the chain; numeric codes of DOMException are skipped.
 * @param chain Error chain.
 * @returns The code, or undefined.
 */
function firstCode(chain: readonly unknown[]): string | undefined {
  for (const item of chain) {
    const code = typeof item === 'object' && item !== null ? (item as ErrorLike).code : undefined;

    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }

  return undefined;
}

/**
 * Sorts a failed request into a taxonomy class.
 * @param error Error thrown by `fetch` or its body read.
 * @param target Which side was called.
 * @returns Class, code and whether the request was certainly not sent.
 */
export function classifyNetworkError(error: unknown, target: NetTarget): NetworkFailure {
  const unavailable = unavailableClass(target);
  const chain = chainOf(error);
  const code = firstCode(chain);

  // Undici reports a port blocked by the fetch standard as a bare `bad port` error without a code.
  if (code === undefined && chain.some(item => item instanceof Error && item.message === 'bad port')) {
    return { errorClass: unavailable,
      code: 'BAD_PORT',
      beforeSend: true };
  }

  if (code === 'ENOTFOUND') {
    return { errorClass: 'dns_error',
      code,
      beforeSend: true };
  }

  if (code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return { errorClass: 'network_error',
      code,
      beforeSend: true };
  }

  if (code === 'ECONNREFUSED') {
    return { errorClass: unavailable,
      code,
      beforeSend: true };
  }

  if (code !== undefined && TLS_CODE.test(code)) {
    return { errorClass: 'tls_error',
      code,
      beforeSend: true };
  }

  if (code === undefined && chain.some(item => item instanceof Error && ABORT_NAMES.has(item.name))) {
    return { errorClass: unavailable,
      code: 'TIMEOUT',
      beforeSend: false };
  }

  return { errorClass: unavailable,
    code: code ?? 'UNKNOWN',
    beforeSend: false };
}
