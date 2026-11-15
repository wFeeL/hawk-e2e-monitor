import { describe, expect, it } from 'vitest';
import { describeError } from '../../src/errors/messages.js';
import { ERROR_CLASSES } from '../../src/errors/taxonomy.js';
import type { MessageFacts } from '../../src/errors/taxonomy.js';

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
  channel: 'webhook',
};

describe('blocked port', () => {
  it('says what is wrong instead of printing a code', () => {
    expect(describeError('collector_unavailable', { url: 'http://c:6000/',
      code: 'BAD_PORT' })).toBe('Collector http://c:6000/ did not respond: the port is blocked by fetch, use another one');
  });
});

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

  it('run_timeout says the run was cancelled when asked', () => {
    expect(describeError('run_timeout', { detail: 'cancelled' })).toBe('The run was cancelled');
    expect(describeError('run_timeout', {})).toBe('The run did not finish');
  });

  it('prints durations for people, not raw milliseconds', () => {
    expect(describeError('collector_unavailable', { url: 'http://c/',
      code: 'TIMEOUT',
      waitedMs: 10_001 })).toBe('Collector http://c/ did not respond: TIMEOUT, waited 10.0 s');
    expect(describeError('collector_unavailable', { url: 'http://c/',
      code: 'TIMEOUT',
      waitedMs: 340 })).toBe('Collector http://c/ did not respond: TIMEOUT, waited 340 ms');
  });

  it('garage_unavailable names the address, what was not served and why', () => {
    expect(describeError('garage_unavailable', { url: 'http://g:8080',
      detail: 'the index page',
      code: 'ECONNREFUSED' })).toBe('Garage at http://g:8080 did not serve the index page: ECONNREFUSED');
    expect(describeError('garage_unavailable', { url: 'http://g:8080',
      detail: 'the index page',
      status: 502 })).toBe('Garage at http://g:8080 did not serve the index page: HTTP 502');
    expect(describeError('garage_unavailable', { url: 'http://g:8080',
      detail: 'the app',
      cause: 'index.html has no module script' })).toBe('Garage at http://g:8080 did not serve the app: index.html has no module script');
    expect(describeError('garage_unavailable', {})).toBe('Garage did not serve its pages');
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
      .toBe('Event did not appear within 2m 0s: API answered 20 times, failed 3 times, last answer 500 ms ago');
    expect(describeError('event_not_found', { waitedMs: 1000,
      successes: 0,
      errors: 5,
      lastSuccessAgoMs: 500 }))
      .toBe('Event did not appear within 1.0 s: API answered 0 times, failed 5 times');
  });

  it('tunnel_unavailable names the reason', () => {
    expect(describeError('tunnel_unavailable', { detail: 'HTTP 502' })).toBe('Tunnel gave no working public address: HTTP 502');
    expect(describeError('tunnel_unavailable', {})).toBe('Tunnel gave no working public address');
  });

  it('receiver_unreachable names the reason', () => {
    expect(describeError('receiver_unreachable', { detail: 'answered HTTP 530' })).toBe('Receiver is not reachable at the public address: answered HTTP 530');
  });

  it('notification_endpoint_rejected names the channel and the Hawk text', () => {
    expect(describeError('notification_endpoint_rejected', { channel: 'loop',
      detail: 'Invalid loop endpoint passed' })).toBe('Hawk rejected the address of the loop channel: Invalid loop endpoint passed');
    expect(describeError('notification_endpoint_rejected', { detail: 'x' })).toBe('Hawk rejected the address of a notification channel: x');
  });

  it('provisioning classes name what changed', () => {
    expect(describeError('provisioning_conflict', { detail: 'rule 1 vanished' })).toBe('The notification rule is being changed in parallel: rule 1 vanished');
    expect(describeError('provisioning_unstable', { detail: 'channels.loop.isEnabled' })).toBe('The notification rule is changed again on every run: channels.loop.isEnabled');
  });

  it('notification_timeout tells the two conclusions apart', () => {
    expect(describeError('notification_timeout', { detail: 'both',
      waitedMs: 120_000 })).toBe('Neither channel arrived within 2m 0s: the notifier or its queue did not hand the notification to a sender');
    expect(describeError('notification_timeout', { detail: 'webhook_only',
      waitedMs: 120_000 })).toBe('The webhook did not arrive within 2m 0s; with the loop channel off the notifier and the sender cannot be told apart');
    expect(describeError('notification_timeout', {})).toBe('Neither channel arrived: the notifier or its queue did not hand the notification to a sender');
  });

  it('notification_mismatch names the field', () => {
    expect(describeError('notification_mismatch', { field: 'payload.project.id',
      expected: 'a',
      actual: 'b' })).toBe('Notification differs from the event: payload.project.id expected a, got b');
  });

  it('duplicate_notification names the channel and the count', () => {
    expect(describeError('duplicate_notification', { channel: 'loop',
      count: 2 })).toBe('The loop notification arrived 2 times');
    expect(describeError('duplicate_notification', { count: 2 })).toBe('The notification arrived 2 times');
  });

  it('names the classes of the monitor itself', () => {
    expect(describeError('run_hung', { waitedMs: 540_000 })).toBe('The run did not finish within 9m 0s and was abandoned');
    expect(describeError('monitor_restarted', {})).toBe('The monitor restarted while the run was in progress');
    expect(describeError('monitor_stopped', {})).toBe('The monitor stopped while the run was in progress');
    expect(describeError('alert_rejected', { status: 404,
      detail: 'no such chat' })).toBe('codex.bot did not accept the alert: 404 no such chat');
    expect(describeError('alert_rejected', { status: 200 })).toBe('codex.bot did not accept the alert: 200');
  });
});
