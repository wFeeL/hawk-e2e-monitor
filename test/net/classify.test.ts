import { describe, expect, it } from 'vitest';
import { classifyNetworkError } from '../../src/net/classify.js';

/**
 * Builds the `fetch failed` shape of undici.
 * @param code Code of the inner error.
 * @returns TypeError with a cause that has the code.
 */
function fetchFailed(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('classifyNetworkError', () => {
  it('maps codes from the cause chain', () => {
    expect(classifyNetworkError(fetchFailed('ENOTFOUND'), 'collector'))
      .toEqual({ errorClass: 'dns_error',
        code: 'ENOTFOUND',
        beforeSend: true });
    expect(classifyNetworkError(fetchFailed('EAI_AGAIN'), 'api').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ENETUNREACH'), 'api').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('EHOSTUNREACH'), 'api').beforeSend).toBe(true);
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'collector'))
      .toEqual({ errorClass: 'collector_unavailable',
        code: 'ECONNREFUSED',
        beforeSend: true });
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'api').errorClass).toBe('api_unavailable');
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_TLS_HANDSHAKE_TIMEOUT',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
    'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
    'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
    'ERR_SSL_UNSUPPORTED_PROTOCOL',
    'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
    'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  ])('a certificate error is tls_error before the send: %s', (code) => {
    expect(classifyNetworkError(fetchFailed(code), 'collector'))
      .toEqual({ errorClass: 'tls_error',
        code,
        beforeSend: true });
  });

  it.each([
    'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
    'ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC',
    'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
    'ERR_SSL_PACKET_LENGTH_TOO_LONG',
  ])('a tls record error may come after the send: %s', (code) => {
    expect(classifyNetworkError(fetchFailed(code), 'collector'))
      .toEqual({ errorClass: 'tls_error',
        code,
        beforeSend: false });
  });

  it('a connect timeout is before the send', () => {
    expect(classifyNetworkError(fetchFailed('UND_ERR_CONNECT_TIMEOUT'), 'collector'))
      .toEqual({ errorClass: 'collector_unavailable',
        code: 'UND_ERR_CONNECT_TIMEOUT',
        beforeSend: true });
  });

  it('treats abort and timeout names as TIMEOUT after send, ignoring numeric codes', () => {
    const timeout = new DOMException('timed out', 'TimeoutError');
    const aborted = new DOMException('aborted', 'AbortError');

    expect(classifyNetworkError(timeout, 'collector'))
      .toEqual({ errorClass: 'collector_unavailable',
        code: 'TIMEOUT',
        beforeSend: false });
    expect(classifyNetworkError(aborted, 'api'))
      .toEqual({ errorClass: 'api_unavailable',
        code: 'TIMEOUT',
        beforeSend: false });
  });

  it('names a port that fetch blocks, as the real fetch reports it', async () => {
    const error = await fetch('http://127.0.0.1:6000/').catch((caught: unknown) => caught);

    expect(classifyNetworkError(error, 'collector'))
      .toEqual({ errorClass: 'collector_unavailable',
        code: 'BAD_PORT',
        beforeSend: true });
  });

  it('keeps other codes and falls back to UNKNOWN', () => {
    expect(classifyNetworkError(fetchFailed('UND_ERR_SOCKET'), 'collector'))
      .toEqual({ errorClass: 'collector_unavailable',
        code: 'UND_ERR_SOCKET',
        beforeSend: false });
    expect(classifyNetworkError('weird', 'api'))
      .toEqual({ errorClass: 'api_unavailable',
        code: 'UNKNOWN',
        beforeSend: false });
  });

  it('the heartbeat target is classified by the network code, not as the collector being down', () => {
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'heartbeat').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ETIMEDOUT'), 'heartbeat').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ENOTFOUND'), 'heartbeat').errorClass).toBe('dns_error');
  });

  it('the garage target blames Garage for a refused or silent connection, and keeps DNS and TLS apart', () => {
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'garage').errorClass).toBe('garage_unavailable');
    expect(classifyNetworkError(fetchFailed('ETIMEDOUT'), 'garage').errorClass).toBe('garage_unavailable');
    expect(classifyNetworkError(fetchFailed('ENOTFOUND'), 'garage').errorClass).toBe('dns_error');
    expect(classifyNetworkError(fetchFailed('CERT_HAS_EXPIRED'), 'garage').errorClass).toBe('tls_error');
  });

  it('the notify target is classified by the network code, not as the collector being down', () => {
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'notify').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ETIMEDOUT'), 'notify').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ENOTFOUND'), 'notify').errorClass).toBe('dns_error');
  });
});

describe('classifyNetworkError for the Telegram API', () => {
  it('names a bot that cannot be reached telegram_api_unavailable', () => {
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'telegram'))
      .toEqual({ errorClass: 'telegram_api_unavailable',
        code: 'ECONNREFUSED',
        beforeSend: true });
  });
});
