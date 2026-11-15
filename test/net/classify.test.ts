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

  it('maps TLS codes', () => {
    for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_CERT_ALTNAME_INVALID',
      'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN']) {
      expect(classifyNetworkError(fetchFailed(code), 'collector'))
        .toEqual({ errorClass: 'tls_error',
          code,
          beforeSend: true });
    }
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

  it('the notify target never blames Hawk: a refused or silent bot is a network error', () => {
    expect(classifyNetworkError(fetchFailed('ECONNREFUSED'), 'notify').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ETIMEDOUT'), 'notify').errorClass).toBe('network_error');
    expect(classifyNetworkError(fetchFailed('ENOTFOUND'), 'notify').errorClass).toBe('dns_error');
  });
});
