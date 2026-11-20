import { describe, expect, it } from 'vitest';
import { CULPRITS, CULPRIT_OF, CheckError, ERROR_CLASSES, isCheckError } from '../../src/errors/taxonomy.js';
import type { Culprit, ErrorClass } from '../../src/errors/taxonomy.js';

/**
 * Builds the text of a class.
 * @param errorClass Class to describe.
 * @param facts Facts the text may mention.
 * @returns The message.
 */
function text(errorClass: ErrorClass, facts: object): string {
  return new CheckError(errorClass, facts).message;
}

const EXPECTED_CULPRITS: readonly (readonly [ErrorClass, Culprit])[] = [
  ['network_error', 'network'],
  ['token_mismatch', 'config'],
  ['quota_exhausted', 'monitor'],
  ['event_not_found', 'hawk'],
  ['api_query_rejected', 'monitor'],
  ['monitor_internal', 'monitor'],
  ['run_timeout', 'monitor'],
  ['cleanup_refused', 'monitor'],
  ['tunnel_unavailable', 'monitor'],
  ['receiver_unreachable', 'monitor'],
  ['notification_endpoint_rejected', 'config'],
  ['provisioning_conflict', 'monitor'],
  ['provisioning_unstable', 'monitor'],
  ['tunnel_reconnected', 'network'],
  ['notification_timeout', 'hawk'],
  ['notification_mismatch', 'hawk'],
  ['duplicate_notification', 'hawk'],
  ['run_hung', 'monitor'],
  ['monitor_restarted', 'monitor'],
  ['monitor_stopped', 'monitor'],
  ['alert_rejected', 'config'],
  ['api_garage_query_failed', 'hawk'],
  ['field_not_masked', 'hawk'],
  ['threshold_early', 'hawk'],
  ['new_token_not_accepted', 'hawk'],
  ['release_rejected', 'hawk'],
  ['release_not_saved', 'hawk'],
  ['sourcemap_not_applied', 'hawk'],
  ['sentry_rejected', 'hawk'],
  ['garage_unavailable', 'hawk'],
  ['api_unexpected_response', 'hawk'],
  ['telegram_auth_failed', 'config'],
  ['telegram_conflict', 'config'],
  ['telegram_bot_misconfigured', 'config'],
  ['telegram_api_unavailable', 'network'],
  ['telegram_bot_unavailable', 'network'],
  ['telegram_not_delivered', 'hawk'],
];

describe('taxonomy', () => {
  it('culprit table covers every class', () => {
    expect(ERROR_CLASSES).toHaveLength(59);

    for (const errorClass of ERROR_CLASSES) {
      expect(CULPRIT_OF[errorClass]).toBeDefined();
    }

    for (const [errorClass, culprit] of EXPECTED_CULPRITS) {
      expect(CULPRIT_OF[errorClass]).toBe(culprit);
    }
  });

  it('CheckError carries class, culprit, facts and a described message', () => {
    const cause = new Error('boom');
    const error = new CheckError('dns_error', { host: 'example.test' }, { cause });

    expect(error.errorClass).toBe('dns_error');
    expect(error.culprit).toBe('hawk');
    expect(error.facts).toEqual({ host: 'example.test' });
    expect(error.message).toContain('example.test');
    expect(error.cause).toBe(cause);
    expect(isCheckError(error)).toBe(true);
    expect(isCheckError(new Error('x'))).toBe(false);
  });

  it('a culprit option replaces the culprit of the class', () => {
    expect(new CheckError('telegram_bot_unavailable', {}, { culprit: 'config' }).culprit).toBe('config');
    expect(new CheckError('telegram_bot_unavailable').culprit).toBe('network');
  });

  it('an explicit message replaces the described one', () => {
    const error = new CheckError('collector_unavailable', {}, { message: 'custom text' });

    expect(error.message).toBe('custom text');
  });
});

describe('texts of the coverage classes', () => {
  it('each new class names its facts', () => {
    expect(text('api_garage_query_failed', { detail: 'boom' })).toContain('boom');
    expect(text('field_not_masked', { field: 'context.password' })).toContain('context.password');
    expect(text('threshold_early', { detail: 'before the repeat' })).toContain('before the repeat');
    expect(text('new_token_not_accepted', { waitedMs: 180_000 })).toContain('3m 0s');
    expect(text('release_rejected', { status: 400,
      detail: 'bad' })).toContain('400');
    expect(text('release_not_saved', { waitedMs: 60_000 })).toContain('1m 0s');
    expect(text('sourcemap_not_applied', { field: 'backtrace[0].file',
      actual: 'x.min.js' })).toContain('backtrace[0].file');
    expect(text('sentry_rejected', { status: 400,
      detail: 'bad' })).toContain('400');
  });

  it('the threshold timeout names the threshold channel', () => {
    const message = text('notification_timeout', { channel: 'threshold',
      waitedMs: 120_000 });

    expect(message).toContain('threshold');
    expect(message).not.toContain('Neither channel');
  });
});

describe('CULPRITS', () => {
  it('lists every culprit once and covers the culprit of each class', () => {
    expect(CULPRITS).toEqual(['hawk', 'monitor', 'config', 'network']);

    for (const errorClass of ERROR_CLASSES) {
      expect(CULPRITS).toContain(CULPRIT_OF[errorClass]);
    }
  });
});

describe('texts of the telegram classes', () => {
  it('each class names the variable or the chain and no token', () => {
    expect(text('telegram_auth_failed', {})).toContain('TELEGRAM_BOT_TOKEN');
    expect(text('telegram_conflict', {})).toContain('webhook');
    expect(text('telegram_bot_misconfigured', { detail: 'privacy mode is on' })).toContain('privacy mode is on');
    expect(text('telegram_api_unavailable', { url: 'https://api.telegram.org/bot***/getMe',
      code: 'ECONNREFUSED' })).toContain('bot***/getMe');
    expect(text('telegram_bot_unavailable', { status: 404,
      url: 'https://notify.bot.codex.so/u/***' })).toContain('TELEGRAM_NOTIFY_URL');
    expect(text('telegram_not_delivered', { detail: 'x' })).toContain('Telegram');
  });
});
