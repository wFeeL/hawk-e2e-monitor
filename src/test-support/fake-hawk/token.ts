import { Buffer } from 'node:buffer';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/**
 * Encodes an integration token the way Hawk SDKs expect it.
 * @param integrationId Id of the integration, usually a UUID.
 * @param secret Secret of the integration, usually a UUID.
 * @returns Base64 of the JSON `{ integrationId, secret }`.
 */
export function encodeToken(integrationId: string, secret: string): string {
  return Buffer.from(JSON.stringify({ integrationId,
    secret })).toString('base64');
}

/**
 * Decodes a token into the collector's cache key.
 * @param token Base64 token.
 * @returns `integrationId + secret` without dashes, or undefined when the token does not decode.
 */
export function decodeTokenKey(token: string): string | undefined {
  if (!BASE64.test(token)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const { integrationId, secret } = parsed as Record<string, unknown>;

    if (typeof integrationId !== 'string' || typeof secret !== 'string' || !integrationId || !secret) {
      return undefined;
    }

    return (integrationId + secret).replaceAll('-', '');
  } catch {
    return undefined;
  }
}
