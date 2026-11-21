import type { Culprit, ErrorClass } from '../errors/taxonomy.js';

const MAX_CHAIN_DEPTH = 8;
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/u;
// Record errors come after the handshake, when the request may have arrived, so only handshake and certificate codes count as not sent.
const TLS_BEFORE_SEND = new RegExp([
  '^(CERT_|UNABLE_TO_|',
  'DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|',
  'ERR_TLS_CERT_ALTNAME_INVALID$|ERR_TLS_HANDSHAKE_TIMEOUT$|',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE$|',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION$|ERR_SSL_TLSV1_UNRECOGNIZED_NAME$|',
  'ERR_SSL_UNSUPPORTED_PROTOCOL$|ERR_SSL_NO_PROTOCOLS_AVAILABLE$|',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA$)',
].join(''), 'u');
// A bad DNS name or certificate of the alert bot, the heartbeat service or Telegram says nothing about Hawk.
const OUTSIDE_HAWK: ReadonlySet<NetTarget> = new Set<NetTarget>(['heartbeat', 'notify', 'telegram']);
const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);

/** Which side a request goes to. */
export type NetTarget = 'api' | 'collector' | 'garage' | 'heartbeat' | 'notify' | 'telegram';

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
    case 'garage':
      return 'garage_unavailable';
    case 'telegram':
      return 'telegram_api_unavailable';
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
  /** Blame that replaces the culprit of the class; set for targets outside Hawk. */
  culprit?: Culprit;
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
function classifyByCode(error: unknown, target: NetTarget): NetworkFailure {
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

  if (code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { errorClass: unavailable,
      code,
      beforeSend: true };
  }

  if (code !== undefined && TLS_CODE.test(code)) {
    return { errorClass: 'tls_error',
      code,
      beforeSend: TLS_BEFORE_SEND.test(code) };
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

/**
 * Sorts a failed request into a taxonomy class and, for targets outside Hawk, names the network as the culprit.
 * @param error Error thrown by `fetch` or its body read.
 * @param target Which side was called.
 * @returns Class, code, whether the request was certainly not sent and the culprit when it is not the class's own.
 */
export function classifyNetworkError(error: unknown, target: NetTarget): NetworkFailure {
  const failure = classifyByCode(error, target);

  if (!OUTSIDE_HAWK.has(target)) {
    return failure;
  }

  return { ...failure,
    culprit: 'network' };
}
