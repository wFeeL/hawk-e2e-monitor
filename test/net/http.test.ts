import { Buffer } from 'node:buffer';
import { createServer as createHttpsServer } from 'node:https';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createSelfSignedCert } from '../support/tls.js';
import { systemClock } from '../../src/time/clock.js';
import { CheckError } from '../../src/errors/taxonomy.js';
import { NetworkError, httpRequest, networkFailureToCheckError, requestWithRetry } from '../../src/net/http.js';
import type { HttpRequest } from '../../src/net/http.js';

/** Server and its base URL. */
interface Listening {
  /** Base URL. */
  url: string;
  /** Running server. */
  server: Server;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];
const cert = createSelfSignedCert();

/**
 * Starts a loopback server.
 * @param handler Request handler.
 * @param secure Serve TLS with the self-signed certificate.
 * @returns Base URL and the server.
 */
async function listen(handler: Handler, secure = false): Promise<Listening> {
  const server = secure
    ? createHttpsServer({ key: cert.key,
        cert: cert.cert }, handler)
    : createServer(handler);

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;

  return { url: `${secure ? 'https://localhost' : 'http://127.0.0.1'}:${String(port)}/`,
    server };
}

/**
 * Builds a GET request.
 * @param url Address.
 * @param overrides Fields to replace.
 * @returns Request with a fresh signal.
 */
function get(url: string, overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { url,
    method: 'GET',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    ...overrides };
}

/**
 * Runs a request that must fail with a network error.
 * @param request Request that is expected to fail.
 * @param target Which side is called.
 * @returns The network error.
 */
async function failure(request: HttpRequest, target: 'collector' | 'api' = 'collector'): Promise<NetworkError> {
  try {
    await httpRequest(request, target);
  } catch (error) {
    if (error instanceof NetworkError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected a NetworkError');
}

afterAll(async () => {
  cert.cleanup();
  await Promise.all(servers.map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }));
});

describe('httpRequest', () => {
  it('returns status, content type and text', async () => {
    const { url } = await listen((_request, response) => {
      response.setHeader('content-type', 'text/json; charset=utf8');
      response.end('{"ok":true}');
    });

    expect(await httpRequest(get(url), 'api')).toEqual({ status: 200,
      contentType: 'text/json; charset=utf8',
      text: '{"ok":true}' });
  });

  it('reads at most maxBytes of the body, across chunks', async () => {
    const { url } = await listen((_request, response) => {
      response.write('a'.repeat(100));
      setTimeout(() => {
        response.end('b'.repeat(100_000));
      }, 50);
    });
    const response = await httpRequest(get(url, { maxBytes: 150 }), 'api');

    expect(response.status).toBe(200);
    expect(response.text).toHaveLength(150);
    expect(response.text.startsWith('a'.repeat(100))).toBe(true);
    expect(response.text.endsWith('b'.repeat(50))).toBe(true);
  });

  it('returns the whole body when it is shorter than maxBytes, multi-byte text included', async () => {
    const { url } = await listen((_request, response) => {
      response.end('héllo');
    });

    expect((await httpRequest(get(url, { maxBytes: 100 }), 'api')).text).toBe('héllo');
  });

  it('sends the body and headers of a POST', async () => {
    const { url } = await listen((request, response) => {
      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.end(`${request.method ?? ''} ${request.headers['x-test'] as string} ${Buffer.concat(chunks).toString()}`);
      });
    });
    const response = await httpRequest(get(url, { method: 'POST',
      headers: Object.fromEntries([['x-test', 'yes']]),
      body: 'payload' }), 'api');

    expect(response.text).toBe('POST yes payload');
  });

  it('refused connection is unavailable before send', async () => {
    const { url, server } = await listen(() => undefined);

    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    const error = await failure(get(url));

    expect(error.failure).toEqual({ errorClass: 'collector_unavailable',
      code: 'ECONNREFUSED',
      beforeSend: true });
    expect(error.message).toBe('ECONNREFUSED');
    expect(error.cause).toBeDefined();
  });

  it('unknown host is dns_error', async () => {
    const error = await failure(get('http://e2e-monitor-test.invalid/', { timeoutMs: 3000 }));

    // Without DNS in the environment the resolver answers EAI_AGAIN.
    expect(['dns_error', 'network_error']).toContain(error.failure.errorClass);
    expect(error.failure.beforeSend).toBe(true);
  });

  it('self-signed TLS is tls_error', async () => {
    const { url } = await listen((_request, response) => {
      response.end('hi');
    }, true);
    const error = await failure(get(url));

    expect(error.failure).toEqual({ errorClass: 'tls_error',
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      beforeSend: true });
  });

  it('slow response is TIMEOUT after send', async () => {
    const { url } = await listen(() => undefined);
    const error = await failure(get(url, { timeoutMs: 100 }), 'api');

    expect(error.failure).toEqual({ errorClass: 'api_unavailable',
      code: 'TIMEOUT',
      beforeSend: false });
  });

  it('aborted signal stops the request', async () => {
    const { url } = await listen(() => undefined);
    const controller = new AbortController();
    const running = failure(get(url, { signal: controller.signal,
      timeoutMs: 5000 }));

    setTimeout(() => {
      controller.abort(new Error('custom reason'));
    }, 30);

    const error = await running;

    expect(error.failure.code).toBe('TIMEOUT');
    expect(error.failure.beforeSend).toBe(false);
  });

  it('3xx is returned, not followed', async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });

    expect(await httpRequest(get(url), 'collector')).toEqual({ status: 302,
      contentType: '',
      text: '' });
  });

  it('a connection reset after send keeps the undici code', async () => {
    const { url } = await listen((request) => {
      request.socket.destroy();
    });
    const error = await failure(get(url));

    expect(error.failure).toEqual({ errorClass: 'collector_unavailable',
      code: 'UND_ERR_SOCKET',
      beforeSend: false });
  });
});

describe('networkFailureToCheckError', () => {
  it('takes class and code from the failure and the host from the url', async () => {
    const error = await failure(get('http://e2e-monitor-test.invalid/', { timeoutMs: 3000 }));
    const checkError = networkFailureToCheckError(error, { url: 'http://e2e-monitor-test.invalid/',
      waitedMs: 5 });

    expect(checkError).toBeInstanceOf(CheckError);
    expect(checkError.errorClass).toBe(error.failure.errorClass);
    expect(checkError.facts).toMatchObject({ code: error.failure.code,
      host: 'e2e-monitor-test.invalid',
      waitedMs: 5 });
    expect(checkError.cause).toBe(error);
  });
});

describe('requestWithRetry', () => {
  const base = { attempts: 3,
    delaysMs: [1],
    clock: systemClock,
    retryStatus: (status: number): boolean => status >= 500,
    retryNetwork: (): boolean => true };

  it('retries a retryable status and returns the first good answer', async () => {
    let calls = 0;
    const { url } = await listen((_request, response) => {
      calls += 1;
      response.statusCode = calls < 3 ? 503 : 200;
      response.end('x');
    });
    const result = await requestWithRetry(get(url), 'api', base);

    expect(result.response.status).toBe(200);
    expect(result.attempts).toBe(3);
  });

  it('returns the last response when attempts run out', async () => {
    let calls = 0;
    const { url } = await listen((_request, response) => {
      calls += 1;
      response.statusCode = 503;
      response.end(`try ${String(calls)}`);
    });
    const result = await requestWithRetry(get(url), 'api', base);

    expect(result.response).toMatchObject({ status: 503,
      text: 'try 3' });
    expect(result.attempts).toBe(3);
  });

  it('does not retry a status that is not retryable', async () => {
    let calls = 0;
    const { url } = await listen((_request, response) => {
      calls += 1;
      response.statusCode = 400;
      response.end('bad');
    });
    const result = await requestWithRetry(get(url), 'api', base);

    expect(result.response.status).toBe(400);
    expect(calls).toBe(1);
  });

  it('rethrows the network error after the last attempt', async () => {
    const { url, server } = await listen(() => undefined);

    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });

    await expect(requestWithRetry(get(url), 'collector', base)).rejects.toBeInstanceOf(NetworkError);
  });

  it('does not retry a network failure the caller rejects', async () => {
    const { url } = await listen(() => undefined);
    let attempts = 0;

    try {
      await requestWithRetry(get(url, { timeoutMs: 50 }), 'collector', { ...base,
        retryNetwork: () => {
          attempts += 1;

          return false;
        } });
    } catch {
      // Expected: the timeout is passed through.
    }

    expect(attempts).toBe(1);
  });
});
