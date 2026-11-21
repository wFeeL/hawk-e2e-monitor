import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encodeToken } from '../support/fake-hawk/token.js';
import { collectorEndpoints, decodeIntegrationToken, tokenKey } from '../../src/hawk/token.js';

describe('integration token', () => {
  it('decodes a valid token', () => {
    const token = encodeToken('id-1', 'sec-2');

    expect(decodeIntegrationToken(token)).toEqual({ integrationId: 'id-1',
      secret: 'sec-2' });
  });

  it('accepts extra JSON fields', () => {
    const token = Buffer.from(JSON.stringify({ integrationId: 'a',
      secret: 'b',
      extra: 1 })).toString('base64');

    expect(decodeIntegrationToken(token)).toEqual({ integrationId: 'a',
      secret: 'b' });
  });

  it('rejects bad tokens', () => {
    const notJson = Buffer.from('nope').toString('base64');
    const emptyId = Buffer.from(JSON.stringify({ integrationId: '',
      secret: 'b' })).toString('base64');
    const numeric = Buffer.from(JSON.stringify({ integrationId: 1,
      secret: 'b' })).toString('base64');

    expect(decodeIntegrationToken('not base64!')).toBeUndefined();
    expect(decodeIntegrationToken('')).toBeUndefined();
    expect(decodeIntegrationToken(notJson)).toBeUndefined();
    expect(decodeIntegrationToken(emptyId)).toBeUndefined();
    expect(decodeIntegrationToken(numeric)).toBeUndefined();
  });

  it('tokenKey removes dashes', () => {
    expect(tokenKey({ integrationId: 'a-b-c',
      secret: 'd-e' })).toBe('abcde');
  });

  it('collectorEndpoints with an explicit URL', () => {
    const token = { integrationId: 'abc',
      secret: 's' };

    expect(collectorEndpoints(token, 'http://localhost:3000')).toEqual({
      postUrl: 'http://localhost:3000/',
      healthUrl: 'http://localhost:3000/health',
      wsUrl: 'ws://localhost:3000/ws',
      releaseUrl: 'http://localhost:3000/release',
      envelopeUrl: 'http://localhost:3000/api/0/envelope/',
    });
    expect(collectorEndpoints(token, 'https://host.test/prefix/')).toEqual({
      postUrl: 'https://host.test/prefix/',
      healthUrl: 'https://host.test/prefix/health',
      wsUrl: 'wss://host.test/prefix/ws',
      releaseUrl: 'https://host.test/prefix/release',
      envelopeUrl: 'https://host.test/prefix/api/0/envelope/',
    });
  });

  it('collectorEndpoints keeps the path prefix in the websocket address', () => {
    const token = { integrationId: 'abc',
      secret: 's' };

    expect(collectorEndpoints(token, 'https://h.example/collector').wsUrl).toBe('wss://h.example/collector/ws');
    expect(collectorEndpoints(token, 'http://h:3000').wsUrl).toBe('ws://h:3000/ws');
  });

  it('collectorEndpoints keeps the path prefix for the release and envelope addresses, with or without a closing slash', () => {
    const token = { integrationId: 'abc',
      secret: 's' };

    for (const base of ['https://host/collector/', 'https://host/collector']) {
      expect(collectorEndpoints(token, base)).toMatchObject({ postUrl: 'https://host/collector/',
        releaseUrl: 'https://host/collector/release',
        envelopeUrl: 'https://host/collector/api/0/envelope/' });
    }
  });

  it('collectorEndpoints derives the host from the token', () => {
    expect(collectorEndpoints({ integrationId: 'abc',
      secret: 's' }, undefined)).toEqual({
      postUrl: 'https://abc.k1.hawk.so/',
      healthUrl: 'https://abc.k1.hawk.so/health',
      wsUrl: 'wss://abc.k1.hawk.so/ws',
      releaseUrl: 'https://abc.k1.hawk.so/release',
      envelopeUrl: 'https://abc.k1.hawk.so/api/0/envelope/',
    });
  });

  it('collectorEndpoints throws on an invalid host', () => {
    expect(() => collectorEndpoints({ integrationId: 'a b',
      secret: 's' }, undefined)).toThrow();
  });
});
