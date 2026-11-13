import { describe, expect, it } from 'vitest';
import { describeError } from './messages.js';
import { ERROR_CLASSES } from './taxonomy.js';
import type { MessageFacts } from './taxonomy.js';

const FULL_FACTS: MessageFacts = {
  stage: 'collector_accept',
  url: 'http://127.0.0.1:1/',
  host: '127.0.0.1',
  status: 503,
  code: 'ECONNREFUSED',
  waitedMs: 1200,
  cause: 'socket hang up',
  field: 'title',
  expected: 'a',
  actual: 'b',
  count: 3,
  successes: 4,
  errors: 2,
  lastSuccessAgoMs: 900,
  detail: 'something',
  projectId: 'abc',
};

describe('describeError', () => {
  it('every class has a non-empty message without "undefined"', () => {
    for (const errorClass of ERROR_CLASSES) {
      for (const facts of [{}, FULL_FACTS]) {
        const text = describeError(errorClass, facts);

        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('NaN');
      }
    }
  });

  it('collector_unavailable text', () => {
    expect(describeError('collector_unavailable', { url: 'http://c/',
      code: 'ECONNREFUSED',
      waitedMs: 12 })).toBe('Collector http://c/ did not respond: ECONNREFUSED, waited 12 ms');
    expect(describeError('collector_unavailable', { url: 'http://c/',
      status: 503,
      waitedMs: 12,
      cause: 'boom' })).toBe('Collector http://c/ did not respond: HTTP 503, waited 12 ms; cause: boom');
    expect(describeError('collector_unavailable', { url: 'http://c/',
      code: 'TIMEOUT' })).toBe('Collector http://c/ did not respond: TIMEOUT');
  });

  it('api_auth_failed text', () => {
    expect(describeError('api_auth_failed', { detail: 'Wrong email or password' }))
      .toBe('Hawk API rejected the monitor account: Wrong email or password. Check HAWK_EMAIL and HAWK_PASSWORD');
  });

  it('accept_uncertain text', () => {
    expect(describeError('accept_uncertain', { url: 'http://c/',
      code: 'TIMEOUT' }))
      .toBe('Collector http://c/ did not confirm the event: TIMEOUT; the run keeps looking for it');
  });

  it('event_not_found text', () => {
    expect(describeError('event_not_found', { waitedMs: 120_000,
      successes: 20,
      errors: 3,
      lastSuccessAgoMs: 500 }))
      .toBe('Event did not appear within 120000 ms: API answered 20 times, failed 3 times, last answer 500 ms ago');
    expect(describeError('event_not_found', { waitedMs: 1000,
      successes: 0,
      errors: 5,
      lastSuccessAgoMs: 500 }))
      .toBe('Event did not appear within 1000 ms: API answered 0 times, failed 5 times');
  });
});
