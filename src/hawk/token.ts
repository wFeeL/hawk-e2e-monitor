import { Buffer } from 'node:buffer';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Decoded integration token. */
export interface IntegrationToken {
  /** Integration id, usually a UUID. */
  integrationId: string;
  /** Integration secret, usually a UUID. */
  secret: string;
}

/** Addresses of the collector. */
export interface CollectorEndpoints {
  /** Where events are posted. */
  postUrl: string;
  /** Health check address. */
  healthUrl: string;
  /** WebSocket address. */
  wsUrl: string;
}

/**
 * Decodes a Hawk integration token.
 * @param token Base64 of the JSON `{ integrationId, secret }`.
 * @returns The parts, or undefined when the token is malformed.
 */
export function decodeIntegrationToken(token: string): IntegrationToken | undefined {
  if (!BASE64.test(token)) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }

    const { integrationId, secret } = parsed as Record<string, unknown>;

    if (typeof integrationId !== 'string' || typeof secret !== 'string' || integrationId === '' || secret === '') {
      return undefined;
    }

    return { integrationId,
      secret };
  } catch {
    return undefined;
  }
}

/**
 * Builds the collector's cache key of a token.
 * @param token Decoded token.
 * @returns `integrationId + secret` without dashes.
 */
export function tokenKey(token: IntegrationToken): string {
  return (token.integrationId + token.secret).replaceAll('-', '');
}

/**
 * Builds collector addresses.
 * @param token Decoded token; its id gives the default host.
 * @param collectorUrl Explicit base URL, or undefined for `https://<id>.k1.hawk.so/`.
 * @returns POST, health and WebSocket addresses.
 * @throws TypeError when the resulting host is not a valid URL.
 */
export function collectorEndpoints(token: IntegrationToken, collectorUrl: string | undefined): CollectorEndpoints {
  const raw = collectorUrl ?? `https://${token.integrationId}.k1.hawk.so/`;
  const base = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  const ws = new URL('/ws', base.origin);

  ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

  return { postUrl: base.href,
    healthUrl: new URL('health', base).href,
    wsUrl: ws.href };
}
