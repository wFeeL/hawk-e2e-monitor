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
    });
    expect(collectorEndpoints(token, 'https://host.test/prefix/')).toEqual({
      postUrl: 'https://host.test/prefix/',
      healthUrl: 'https://host.test/prefix/health',
      wsUrl: 'wss://host.test/ws',
    });
  });

  it('collectorEndpoints derives the host from the token', () => {
    expect(collectorEndpoints({ integrationId: 'abc',
      secret: 's' }, undefined)).toEqual({
      postUrl: 'https://abc.k1.hawk.so/',
      healthUrl: 'https://abc.k1.hawk.so/health',
      wsUrl: 'wss://abc.k1.hawk.so/ws',
    });
  });

  it('collectorEndpoints throws on an invalid host', () => {
    expect(() => collectorEndpoints({ integrationId: 'a b',
      secret: 's' }, undefined)).toThrow();
  });
});
