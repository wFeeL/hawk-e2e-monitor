import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckError } from '../../src/errors/taxonomy.js';
import type { ErrorClass } from '../../src/errors/taxonomy.js';
import { collectorEndpoints, decodeIntegrationToken } from '../../src/hawk/token.js';
import { startEndlessServer } from '../support/endless-server.js';
import { startFakeCollector } from '../support/fake-hawk/collector.js';
import type { FakeCollector } from '../support/fake-hawk/collector.js';
import { createFakeStore } from '../support/fake-hawk/store.js';
import type { FakeStore } from '../support/fake-hawk/store.js';
import { decodeTokenKey, encodeToken } from '../support/fake-hawk/token.js';
import { reservedPort } from '../support/ports.js';
import type { RetryPolicy } from '../../src/net/retry.js';
import { systemClock } from '../../src/time/clock.js';
import { PROBE_TOKEN, classifyCollectorReply, createCollectorClient } from '../../src/clients/collector.js';
import type { CollectorClient, CollectorMessage, SendAccepted, SendOutcome, SendRejected, SendUncertain } from '../../src/clients/collector.js';

const PROJECT_ID = 'b'.repeat(24);
const VALID_TOKEN = encodeToken(randomUUID(), randomUUID());
const OK_BODY = '{"code":200,"error":false,"message":"OK"}';

let store: FakeStore;
let collector: FakeCollector;
let signal: AbortSignal;

/**
 * Builds a message with the valid token.
 * @param title Event title.
 * @returns Message for `send`.
 */
function message(title = 'collector test'): CollectorMessage {
  return { token: VALID_TOKEN,
    catcherType: 'errors/nodejs',
    payload: { title } };
}

/**
 * Builds a client for the running fake.
 * @param httpTimeoutMs Request deadline.
 * @param url Collector base URL.
 * @param retry Attempts and pauses, 3 attempts with 1 ms pauses by default.
 * @returns Client with the given retry policy.
 */
function clientFor(httpTimeoutMs = 1000, url = collector.url, retry: RetryPolicy = { attempts: 3,
  delaysMs: [1, 1] }): CollectorClient {
  const token = decodeIntegrationToken(VALID_TOKEN);

  if (!token) {
    throw new Error('token');
  }

  return createCollectorClient({ endpoints: collectorEndpoints(token, url),
    httpTimeoutMs,
    clock: systemClock,
    retry });
}

/**
 * Narrows an outcome to accepted.
 * @param outcome Result of `send`.
 * @returns The accepted outcome.
 */
function accepted(outcome: SendOutcome): SendAccepted {
  if (outcome.kind !== 'accepted') {
    throw new Error(`Expected accepted, got ${JSON.stringify(outcome)}`);
  }

  return outcome;
}

/**
 * Narrows an outcome to rejected.
 * @param outcome Result of `send`.
 * @returns The rejected outcome.
 */
function rejected(outcome: SendOutcome): SendRejected {
  if (outcome.kind !== 'rejected') {
    throw new Error(`Expected rejected, got ${JSON.stringify(outcome)}`);
  }

  return outcome;
}

/**
 * Narrows an outcome to uncertain.
 * @param outcome Result of `send`.
 * @returns The uncertain outcome.
 */
function uncertain(outcome: SendOutcome): SendUncertain {
  if (outcome.kind !== 'uncertain') {
    throw new Error(`Expected uncertain, got ${JSON.stringify(outcome)}`);
  }

  return outcome;
}

/**
 * Awaits a promise that must reject with a CheckError.
 * @param promise Call that is expected to fail.
 * @returns The CheckError the call rejected with.
 */
async function checkError(promise: Promise<void>): Promise<CheckError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CheckError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected a CheckError');
}

/**
 * Builds the URL of a collector that is not there.
 * @returns URL on a port nothing listens on.
 */
async function missingCollectorUrl(): Promise<string> {
  return `http://127.0.0.1:${String(await reservedPort())}/`;
}

beforeEach(async () => {
  store = createFakeStore();
  collector = await startFakeCollector({ store,
    projectId: PROJECT_ID,
    validTokenKey: decodeTokenKey(VALID_TOKEN) ?? '' });
  signal = new AbortController().signal;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await collector.close();
});

const REPLY_TABLE: readonly (readonly [string, number, string, ErrorClass | 'accepted'])[] = [
  ['200 OK', 200, OK_BODY, 'accepted'],
  ['200 not JSON', 200, 'fine', 'collector_unexpected_response'],
  ['200 with error true', 200, '{"code":200,"error":true,"message":"x"}', 'collector_unexpected_response'],
  ['200 without error flag', 200, '{"code":200,"message":"OK"}', 'collector_unexpected_response'],
  ['400 token invalid', 400, '{"code":400,"error":true,"message":"Integration token invalid: abc123"}', 'auth_invalid_token'],
  ['400 too large JSON', 400, '{"code":400,"error":true,"message":"Request is too large"}', 'payload_too_large'],
  ['400 other JSON', 400, '{"code":400,"error":true,"message":"Payload is empty"}', 'bad_request'],
  ['400 JSON without message', 400, '{"code":400}', 'bad_request'],
  ['400 plain', 400, 'Bad request', 'collector_unexpected_response'],
  ['400 HTML page', 400, '<html>400 Bad Request</html>', 'collector_unexpected_response'],
  ['402 quota', 402, '{"code":402,"error":true,"message":"Project has exceeded the events limit"}', 'quota_exhausted'],
  ['402 rate limit', 402, '{"code":402,"error":true,"message":"Rate limit exceeded"}', 'rate_limited'],
  ['402 limiter failure', 402, '{"code":402,"error":true,"message":"Failed to update rate limit"}', 'collector_dependency_error'],
  ['402 other', 402, '{"code":402,"error":true,"message":"Pay up"}', 'unknown_402'],
  ['413 plain', 413, 'Request is too large', 'payload_too_large'],
  ['429 plain', 429, 'Too Many Requests', 'ip_blacklisted'],
  ['413 JSON', 413, '{"code":413,"message":"x"}', 'collector_unexpected_response'],
  ['401', 401, 'nope', 'collector_unexpected_response'],
  ['403', 403, 'nope', 'collector_unexpected_response'],
  ['404', 404, 'Not found', 'collector_unexpected_response'],
  ['405', 405, 'nope', 'collector_unexpected_response'],
  ['302', 302, '', 'collector_unexpected_response'],
];

describe('classifyCollectorReply', () => {
  it.each(REPLY_TABLE)('%s', (_name, status, body, expected) => {
    const verdict = classifyCollectorReply(status, body);

    expect(verdict.kind === 'accepted' ? 'accepted' : verdict.errorClass).toBe(expected);
  });

  it('flattens an HTML body into one line without tags', () => {
    const verdict = classifyCollectorReply(404, '<html>\n<body>\n  <h1>404 Not   Found</h1>\n</body>\n</html>\n');

    expect(verdict).toEqual({ kind: 'rejected',
      errorClass: 'collector_unexpected_response',
      message: 'HTTP 404 404 Not Found' });
  });

  it('cuts a long body to 200 characters', () => {
    const verdict = classifyCollectorReply(404, 'a'.repeat(500));

    expect(verdict.kind === 'rejected' ? verdict.message : '').toBe(`HTTP 404 ${'a'.repeat(200)}`);
  });

  it('keeps the address hint for a 400 page of a proxy', async () => {
    collector.knobs.reply = () => ({ status: 400,
      body: '<html><body><h1>400 Bad Request</h1><hr>nginx</body></html>',
      contentType: 'text/html' });

    const { error } = rejected(await clientFor().send(message(), 'http', signal));

    expect(error.errorClass).toBe('collector_unexpected_response');
    expect(error.message).toContain('check HAWK_COLLECTOR_URL');
    expect(error.message).not.toContain('handler failed');
  });

  it('names a plain-text 400 as a handler failure', () => {
    expect(classifyCollectorReply(400, 'Bad request')).toEqual({ kind: 'rejected',
      errorClass: 'collector_unexpected_response',
      message: 'Bad request (plain text instead of JSON)' });
  });

  it('strips the secret tail from the rejected message', () => {
    expect(classifyCollectorReply(400, '{"message":"Integration token invalid: abc123"}'))
      .toEqual({ kind: 'rejected',
        errorClass: 'auth_invalid_token',
        message: 'Integration token invalid' });
  });

  it('describes a non-JSON body by status and a short snippet', () => {
    const verdict = classifyCollectorReply(404, 'x'.repeat(500));

    expect(verdict.kind === 'rejected' ? verdict.message : '').toBe(`HTTP 404 ${'x'.repeat(200)}`);
  });
});

describe('send over HTTP', () => {
  it.each(REPLY_TABLE.filter(([, status]) => status !== 302))('%s through the fake', async (_name, status, body, expected) => {
    collector.knobs.reply = { status,
      body,
      contentType: status === 200 || status === 400 || status === 402 ? 'text/json; charset=utf8' : 'text/plain; charset=utf-8' };

    const outcome = await clientFor().send(message(), 'http', signal);

    expect(outcome.kind === 'rejected' ? outcome.error.errorClass : outcome.kind).toBe(expected === 'accepted' ? 'accepted' : expected);
    expect(collector.posts).toBe(1);
  });

  it('accepts a valid event and stores it', async () => {
    const outcome = accepted(await clientFor().send(message('stored'), 'http', signal));

    expect(outcome.attempts).toBe(1);
    expect(store.all(PROJECT_ID)).toHaveLength(1);
  });

  it('5xx after accept is uncertain and not retried', async () => {
    collector.knobs.replyAfterAccept = { status: 503,
      body: 'Service Unavailable',
      contentType: 'text/plain' };

    const outcome = uncertain(await clientFor().send(message(), 'http', signal));

    expect(outcome.cause.errorClass).toBe('collector_unavailable');
    expect(outcome.cause.facts).toMatchObject({ status: 503,
      url: collector.url });
    expect(outcome.attempts).toBe(1);
    expect(collector.posts).toBe(1);
  });

  it('a tls handshake alert is resent, as nothing was sent', async () => {
    const real = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch');

    spy.mockImplementationOnce(async () => Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('handshake failure'), { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE' }) })));
    spy.mockImplementation(real);

    const outcome = accepted(await clientFor().send(message(), 'http', signal));

    expect(outcome.attempts).toBe(2);
    expect(collector.posts).toBe(1);
  });

  it('a tls record error after the request is uncertain and not resent', async () => {
    const real = globalThis.fetch;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await real(...args);

      await response.arrayBuffer();

      throw new TypeError('fetch failed', { cause: Object.assign(new Error('bad record mac'), { code: 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC' }) });
    });

    uncertain(await clientFor().send(message(), 'http', signal));
    expect(collector.posts).toBe(1);
  });

  it('timeout after accept is uncertain and not retried', async () => {
    collector.knobs.replyDelayMs = 300;

    const outcome = uncertain(await clientFor(100).send(message(), 'http', signal));

    expect(outcome.cause.errorClass).toBe('collector_unavailable');
    expect(outcome.cause.facts.code).toBe('TIMEOUT');
    expect(collector.posts).toBe(1);
    expect(store.all(PROJECT_ID)).toHaveLength(1);
  });

  it('refused connection is retried 3 times then rejected', async () => {
    const url = await missingCollectorUrl();
    const outcome = rejected(await clientFor(1000, url).send(message(), 'http', signal));

    expect(outcome.error.errorClass).toBe('collector_unavailable');
    expect(outcome.error.facts.code).toBe('ECONNREFUSED');
    expect(outcome.attempts).toBe(3);
  });

  it('uses the configured number of attempts', async () => {
    const url = await missingCollectorUrl();
    const outcome = rejected(await clientFor(1000, url, { attempts: 5,
      delaysMs: [1, 1, 1, 1] }).send(message(), 'http', signal));

    expect(outcome.attempts).toBe(5);
    expect(rejected(await clientFor(1000, url, { attempts: 1,
      delaysMs: [] }).send(message(), 'http', signal)).attempts).toBe(1);
  });

  it('token secret never appears in outcome', async () => {
    const stranger = encodeToken(randomUUID(), randomUUID());
    const key = decodeTokenKey(stranger) ?? '';

    for (const transport of ['http', 'ws'] as const) {
      const outcome = rejected(await clientFor().send({ ...message(),
        token: stranger }, transport, signal));

      expect(outcome.error.errorClass).toBe('auth_invalid_token');
      expect(JSON.stringify(outcome)).not.toContain(key);
      expect(outcome.error.message).not.toContain(key);
    }
  });
});

describe('send over WebSocket', () => {
  it('ws accepted', async () => {
    const outcome = accepted(await clientFor().send(message('ws event'), 'ws', signal));

    expect(outcome.attempts).toBe(1);
    expect(store.all(PROJECT_ID)).toHaveLength(1);
  });

  it('classifies the code in the body', async () => {
    collector.knobs.reply = { status: 200,
      body: '{"code":402,"error":true,"message":"Rate limit exceeded"}' };

    expect(rejected(await clientFor().send(message(), 'ws', signal)).error.errorClass).toBe('rate_limited');
  });

  it('a body that is not JSON is an unexpected response', async () => {
    collector.knobs.reply = { status: 200,
      body: 'hello' };

    expect(rejected(await clientFor().send(message(), 'ws', signal)).error.errorClass).toBe('collector_unexpected_response');
  });

  it('ws close_after_message is uncertain', async () => {
    collector.knobs.ws = 'close_after_message';

    const outcome = uncertain(await clientFor().send(message(), 'ws', signal));

    expect(outcome.cause.errorClass).toBe('collector_unavailable');
    expect(outcome.cause.facts).toMatchObject({ code: 'WS_CLOSED',
      url: collector.wsUrl });
  });

  it('ws silent is uncertain with TIMEOUT', async () => {
    collector.knobs.ws = 'silent';

    expect(uncertain(await clientFor(100).send(message(), 'ws', signal)).cause.facts.code).toBe('TIMEOUT');
  });

  it('a plain-text 400 over HTTP reads as a failed handler', async () => {
    collector.knobs.reply = () => ({ status: 400,
      body: 'Bad request',
      contentType: 'text/plain; charset=utf-8' });

    const { error } = rejected(await clientFor().send(message(), 'http', signal));

    expect(error.errorClass).toBe('collector_unexpected_response');
    expect(error.message).toBe('Collector handler failed: HTTP 400 Bad request (plain text instead of JSON)');
  });

  it('ws timeout before the socket opens names TIMEOUT and the wait', async () => {
    const silent = createNetServer();

    await new Promise<void>((resolve) => {
      silent.listen(0, '127.0.0.1', resolve);
    });

    try {
      const { port } = silent.address() as AddressInfo;
      const { error } = rejected(await clientFor(150, `http://127.0.0.1:${String(port)}`, { attempts: 1,
        delaysMs: [] }).send(message(), 'ws', signal));

      expect(error.errorClass).toBe('ws_handshake_failed');
      expect(error.message).toMatch(/did not open: TIMEOUT, waited \d+ ms$/u);
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });

  it('ws reject_upgrade is rejected after 3 handshakes', async () => {
    collector.knobs.ws = 'reject_upgrade';

    const outcome = rejected(await clientFor().send(message(), 'ws', signal));

    expect(outcome.error.errorClass).toBe('ws_handshake_failed');
    expect(outcome.attempts).toBe(3);
    expect(collector.wsMessages).toBe(0);
  });
});

describe('health', () => {
  it('stops reading an endless body at the limit and calls it an unexpected response', async () => {
    const endless = await startEndlessServer();

    try {
      expect((await checkError(clientFor(1000, endless.url).health(signal))).errorClass).toBe('collector_unexpected_response');
    } finally {
      await endless.close();
    }
  });

  it('health ok', async () => {
    await expect(clientFor().health(signal)).resolves.toBeUndefined();
  });

  it('health flags false is dependency error', async () => {
    collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const error = await checkError(clientFor().health(signal));

    expect(error.errorClass).toBe('collector_dependency_error');
    expect(error.facts.detail).toBe('redis_status=false, mongo_db_status=true');
  });

  it('flags false with status 200 is also a dependency error', async () => {
    collector.knobs.health = { status: 200,
      redis: true,
      mongo: false };

    expect((await checkError(clientFor().health(signal))).errorClass).toBe('collector_dependency_error');
  });

  it('a 5xx JSON without a flag is a gateway answer and ends unavailable', async () => {
    collector.knobs.health = { status: 500,
      text: '{}' };

    const error = await checkError(clientFor().health(signal));

    expect(error.errorClass).toBe('collector_unavailable');
    expect(error.facts.status).toBe(500);
  });

  it('5xx without JSON is unavailable', async () => {
    collector.knobs.health = { status: 503,
      text: 'down' };

    const error = await checkError(clientFor().health(signal));

    expect(error.errorClass).toBe('collector_unavailable');
    expect(error.facts.status).toBe(503);
  });

  it('health on 429 Too Many Requests is ip_blacklisted', async () => {
    collector.knobs.blacklisted = true;

    const error = await checkError(clientFor().health(signal));

    expect(error.errorClass).toBe('ip_blacklisted');
    expect(error.culprit).toBe('monitor');
    expect(error.facts.status).toBe(429);
  });

  it('health 400 with the panic body says the handler failed', async () => {
    collector.knobs.health = { status: 400,
      text: 'Bad request' };

    const error = await checkError(clientFor().health(signal));

    expect(error.errorClass).toBe('collector_unexpected_response');
    expect(error.message).toBe('Collector handler failed: HTTP 400 Bad request (plain text instead of JSON)');
  });

  it('health 400 page of a proxy keeps the address hint', async () => {
    collector.knobs.health = { status: 400,
      text: '<html>400 Bad Request nginx</html>' };

    const error = await checkError(clientFor().health(signal));

    expect(error.message).toContain('check HAWK_COLLECTOR_URL');
    expect(error.message).not.toContain('handler failed');
  });

  it('other statuses are unexpected', async () => {
    collector.knobs.health = { status: 404,
      text: 'Not found' };

    expect((await checkError(clientFor().health(signal))).errorClass).toBe('collector_unexpected_response');
  });

  it('refused connection is unavailable', async () => {
    const url = await missingCollectorUrl();
    const error = await checkError(clientFor(1000, url).health(signal));

    expect(error.errorClass).toBe('collector_unavailable');
    expect(error.facts.code).toBe('ECONNREFUSED');
  });
});

describe('probeInvalidToken', () => {
  it('PROBE_TOKEN decodes to the constant UUID', () => {
    expect(decodeIntegrationToken(PROBE_TOKEN)).toEqual({ integrationId: '00000000-0000-4000-8000-000000000000',
      secret: '00000000-0000-4000-8000-000000000000' });
  });

  it('probe ok on fake', async () => {
    await expect(clientFor().probeInvalidToken(signal)).resolves.toBeUndefined();
    expect(collector.wsMessages).toBe(1);
    expect(store.all(PROJECT_ID)).toHaveLength(0);
  });

  it('probe unexpected when the fake accepts any token', async () => {
    collector.knobs.reply = { status: 200,
      body: OK_BODY };

    expect((await checkError(clientFor().probeInvalidToken(signal))).errorClass).toBe('collector_unexpected_response');
  });

  it('handshake failure is ws_handshake_failed after 3 attempts', async () => {
    collector.knobs.ws = 'reject_upgrade';

    expect((await checkError(clientFor().probeInvalidToken(signal))).errorClass).toBe('ws_handshake_failed');
  });

  it('a silent socket is unavailable', async () => {
    collector.knobs.ws = 'silent';

    const error = await checkError(clientFor(100).probeInvalidToken(signal));

    expect(error.errorClass).toBe('collector_unavailable');
    expect(error.facts.code).toBe('TIMEOUT');
  });
});

const MAP_FILE = { name: 'e2e-rabc.min.js.map',
  content: JSON.stringify({ version: 3,
    file: 'e2e-rabc.min.js',
    sources: ['e2e-source.js'],
    sourcesContent: ['x'],
    names: [],
    mappings: 'AAKA' }) };

describe('uploadRelease', () => {
  it('sends the release and the file with the token as a bearer, and the collector keeps them', async () => {
    const outcome = accepted(await clientFor().uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.attempts).toBe(1);
    expect(collector.releasePosts).toBe(1);
    await vi.waitFor(() => {
      expect(store.releases.find(PROJECT_ID, 'rel-1')?.files.map(file => file.mapFileName)).toEqual(['e2e-rabc.min.js.map']);
    });
    expect(store.releases.find(PROJECT_ID, 'rel-1')?.files[0]?.originFileName).toBe('e2e-rabc.min.js');
  });

  it('posts to the release path of the root, not to the event path', async () => {
    await clientFor().uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal);

    expect(collector.posts).toBe(0);
    expect(collector.releasePosts).toBe(1);
  });

  it('an unknown token is auth_invalid_token', async () => {
    const other = encodeToken(randomUUID(), randomUUID());
    const outcome = rejected(await clientFor().uploadRelease(other, 'rel-1', MAP_FILE, signal));

    expect(outcome.error.errorClass).toBe('auth_invalid_token');
    expect(outcome.error.message).not.toContain(decodeTokenKey(other) ?? 'unreachable');
  });

  it.each([
    ['a refusal of the release', 400, '{"code":400,"error":true,"message":"provide `release` form value"}', 'release_rejected'],
    ['a plain 400 of a proxy', 400, 'Bad gateway', 'release_rejected'],
    ['the plain 400 of a collector handler that panicked', 400, 'Bad request', 'collector_unexpected_response'],
    ['the event limit', 402, '{"code":402,"error":true,"message":"Project has exceeded the events limit"}', 'quota_exhausted'],
    ['an unexpected status', 404, 'Not found', 'release_rejected'],
    ['an answer of 200 that says error', 200, '{"code":200,"error":true,"message":"x"}', 'release_rejected'],
  ] as const)('%s is %s', async (_name, status, body, expected) => {
    collector.knobs.releaseReply = { status,
      body };

    const outcome = rejected(await clientFor().uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.error.errorClass).toBe(expected);

    if (expected === 'release_rejected') {
      expect(outcome.error.facts.status).toBe(status);
    }
  });

  it('reads a flat line of an HTML refusal, not the page', async () => {
    collector.knobs.releaseReply = { status: 404,
      body: '<html>\n<body>\n<h1>Not   found</h1>\n</body>\n</html>',
      contentType: 'text/html' };

    const outcome = rejected(await clientFor().uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.error.facts.detail).toBe('HTTP 404 Not found');
  });

  it('stops reading an endless answer at the limit and calls it an unexpected response', async () => {
    const endless = await startEndlessServer();

    try {
      const outcome = rejected(await clientFor(1000, endless.url).uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

      expect(outcome.error.errorClass).toBe('collector_unexpected_response');
    } finally {
      await endless.close();
    }
  });

  it('a 5xx answer is uncertain, because the release may have been published', async () => {
    collector.knobs.releaseReply = { status: 503,
      body: 'down' };

    const outcome = uncertain(await clientFor().uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.cause.errorClass).toBe('collector_unavailable');
    expect(collector.releasePosts).toBe(1);
  });

  it('a collector that is not there is rejected before the send, after the attempts', async () => {
    const url = await missingCollectorUrl();
    const outcome = rejected(await clientFor(1000, url).uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.error.errorClass).toBe('collector_unavailable');
    expect(outcome.attempts).toBe(3);
  });

  it('a request that times out after the send is uncertain and not repeated', async () => {
    collector.knobs.replyDelayMs = 400;

    const outcome = uncertain(await clientFor(100).uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal));

    expect(outcome.attempts).toBe(1);
  });
});

const SENT_AT_LINE = JSON.stringify(Object.fromEntries([['sent_at', '2026-11-15T12:00:00.000Z']]));
const ENVELOPE = [
  SENT_AT_LINE,
  JSON.stringify({ type: 'event' }),
  JSON.stringify({ exception: { values: [{ type: 'E2eMonitorCheck',
    value: '[e2e:t] rabc sentry-envelope' }] },
  level: 'error',
  sdk: { name: 'sentry.python',
    version: '1.0.0' },
  contexts: { e2e: { runId: 'rabc',
    instanceId: 't' } } }),
  '',
].join('\n');
const KEY = decodeTokenKey(VALID_TOKEN) ?? '';

describe('sendEnvelope', () => {
  it('posts the envelope to the Sentry path with the key in the query, and the event arrives with a title of type and value', async () => {
    const outcome = accepted(await clientFor().sendEnvelope(KEY, ENVELOPE, signal));
    const [event] = store.all(PROJECT_ID);

    expect(outcome.attempts).toBe(1);
    expect(collector.envelopePosts).toBe(1);
    expect(collector.posts).toBe(0);
    expect(event).toMatchObject({ catcherType: 'errors/default' });
    expect(event?.payload).toMatchObject({ title: 'E2eMonitorCheck: [e2e:t] rabc sentry-envelope',
      type: 'error',
      context: { e2e: { runId: 'rabc',
        instanceId: 't' } } });
  });

  it('an envelope with no event is answered 200 and stores nothing', async () => {
    const outcome = accepted(await clientFor().sendEnvelope(KEY, `${SENT_AT_LINE}\n${JSON.stringify({ type: 'client_report' })}\n{}\n`, signal));

    expect(outcome.attempts).toBe(1);
    expect(store.all(PROJECT_ID)).toHaveLength(0);
  });

  it('an unknown key is auth_invalid_token, without the key in the text', async () => {
    const other = decodeTokenKey(encodeToken(randomUUID(), randomUUID())) ?? '';
    const outcome = rejected(await clientFor().sendEnvelope(other, ENVELOPE, signal));

    expect(outcome.error.errorClass).toBe('auth_invalid_token');
    expect(outcome.error.message).not.toContain(other);
  });

  it('keeps the key out of the facts of every failure', async () => {
    collector.knobs.envelopeReply = { status: 400,
      body: '{"code":400,"error":true,"message":"Failed to process Sentry envelope"}' };

    const outcome = rejected(await clientFor().sendEnvelope(KEY, ENVELOPE, signal));

    expect(JSON.stringify(outcome.error.facts)).not.toContain(KEY);
    expect(JSON.stringify(outcome.error.facts)).not.toContain('sentry_key');
  });

  it.each([
    ['a refusal of the envelope', 400, '{"code":400,"error":true,"message":"Failed to process Sentry envelope"}', 'sentry_rejected'],
    ['a plain 400 of a proxy', 400, 'Bad gateway', 'sentry_rejected'],
    ['the plain 400 of a collector handler that panicked', 400, 'Bad request', 'collector_unexpected_response'],
    ['the event limit', 402, '{"code":402,"error":true,"message":"Project has exceeded the events limit"}', 'quota_exhausted'],
    ['an unexpected status', 404, 'Not found', 'sentry_rejected'],
    ['a 200 that says error', 200, '{"code":200,"error":true,"message":"x"}', 'sentry_rejected'],
  ] as const)('%s is %s', async (_name, status, body, expected) => {
    collector.knobs.envelopeReply = { status,
      body };

    const outcome = rejected(await clientFor().sendEnvelope(KEY, ENVELOPE, signal));

    expect(outcome.error.errorClass).toBe(expected);

    if (expected === 'sentry_rejected') {
      expect(outcome.error.facts.status).toBe(status);
    }
  });

  it('reads a flat line of an HTML refusal, not the page', async () => {
    collector.knobs.envelopeReply = { status: 404,
      body: '<html>\n<body>\n<h1>Not   found</h1>\n</body>\n</html>',
      contentType: 'text/html' };

    const outcome = rejected(await clientFor().sendEnvelope(KEY, ENVELOPE, signal));

    expect(outcome.error.facts.detail).toBe('HTTP 404 Not found');
  });

  it('stops reading an endless answer at the limit and calls it an unexpected response', async () => {
    const endless = await startEndlessServer();

    try {
      const outcome = rejected(await clientFor(1000, endless.url).sendEnvelope(KEY, ENVELOPE, signal));

      expect(outcome.error.errorClass).toBe('collector_unexpected_response');
    } finally {
      await endless.close();
    }
  });

  it('a 5xx answer is uncertain', async () => {
    collector.knobs.envelopeReply = { status: 503,
      body: 'down' };

    expect(uncertain(await clientFor().sendEnvelope(KEY, ENVELOPE, signal)).cause.errorClass).toBe('collector_unavailable');
  });

  it('a collector that is not there is rejected before the send', async () => {
    const url = await missingCollectorUrl();
    const outcome = rejected(await clientFor(1000, url).sendEnvelope(KEY, ENVELOPE, signal));

    expect(outcome.error.errorClass).toBe('collector_unavailable');
    expect(outcome.attempts).toBe(3);
  });
});

/** A local server that answers every request with what the next entry says. */
interface ScriptedServer {
  /** Base URL with a closing slash. */
  url: string;
  /** Requests received. */
  requests: () => number;
  /** Stops the server. */
  close: () => Promise<void>;
}

/**
 * Starts a server whose answers come from a list; the last entry repeats.
 * @param answers Status and body, one pair per request.
 * @returns The running server.
 */
async function scriptedServer(answers: readonly (readonly [number, string])[]): Promise<ScriptedServer> {
  let received = 0;
  const server = createNetServer((request, response) => {
    request.resume();

    const [status, body] = answers[Math.min(received, answers.length - 1)] ?? [500, ''];

    received += 1;
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`,
    requests: () => received,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    } };
}

describe('gateway answers and oversized bodies', () => {
  const GATEWAY = '{"error":"bad gateway"}';
  const HUGE = 'x'.repeat(5 * 1024 * 1024);

  it('retries a 502 JSON of a proxy and succeeds when the collector is back', async () => {
    const server = await scriptedServer([[502, GATEWAY], [502, GATEWAY], [200, '{"redis_status":true,"mongo_db_status":true}']]);

    try {
      await expect(clientFor(1000, server.url).health(signal)).resolves.toBeUndefined();
      expect(server.requests()).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('an endless 502 JSON ends unavailable', async () => {
    const server = await scriptedServer([[502, GATEWAY]]);

    try {
      const error = await checkError(clientFor(1000, server.url).health(signal));

      expect(error.errorClass).toBe('collector_unavailable');
      expect(error.facts.status).toBe(502);
      expect(server.requests()).toBe(3);
    } finally {
      await server.close();
    }
  });

  it('200 JSON without a health flag is an unexpected response', async () => {
    const server = await scriptedServer([[200, '{"status":"ok"}']]);

    try {
      expect((await checkError(clientFor(1000, server.url).health(signal))).errorClass).toBe('collector_unexpected_response');
    } finally {
      await server.close();
    }
  });

  it('a health body over the limit is reported as too large', async () => {
    const server = await scriptedServer([[200, HUGE]]);

    try {
      const error = await checkError(clientFor(5000, server.url).health(signal));

      expect(error.errorClass).toBe('collector_unexpected_response');
      expect(error.facts.detail).toBe('response larger than 65536 bytes');
    } finally {
      await server.close();
    }
  });

  it('a send, release and envelope answer over the limit is reported as too large', async () => {
    const server = await scriptedServer([[200, HUGE]]);

    try {
      const client = clientFor(5000, server.url);
      const outcomes = [
        await client.send(message(), 'http', signal),
        await client.uploadRelease(VALID_TOKEN, 'rel-1', MAP_FILE, signal),
        await client.sendEnvelope('key', 'x', signal),
      ];

      for (const outcome of outcomes) {
        const { error } = rejected(outcome);

        expect(error.errorClass).toBe('collector_unexpected_response');
        expect(error.facts.detail).toBe('response larger than 65536 bytes');
      }
    } finally {
      await server.close();
    }
  });

  it('classifyCollectorReply names a truncated body', () => {
    expect(classifyCollectorReply(200, OK_BODY.slice(0, 10), true)).toEqual({ kind: 'rejected',
      errorClass: 'collector_unexpected_response',
      message: 'response larger than 65536 bytes' });
  });
});
