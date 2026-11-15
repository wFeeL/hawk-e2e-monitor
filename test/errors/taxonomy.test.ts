import { describe, expect, it } from 'vitest';
import { CULPRITS, CULPRIT_OF, CheckError, ERROR_CLASSES, isCheckError } from '../../src/errors/taxonomy.js';
import type { Culprit, ErrorClass } from '../../src/errors/taxonomy.js';

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
  ['notification_timeout', 'hawk'],
  ['notification_mismatch', 'hawk'],
  ['duplicate_notification', 'hawk'],
  ['run_hung', 'monitor'],
  ['monitor_restarted', 'monitor'],
  ['monitor_stopped', 'monitor'],
  ['alert_rejected', 'config'],
  ['garage_unavailable', 'hawk'],
];

describe('taxonomy', () => {
  it('culprit table covers every class', () => {
    expect(ERROR_CLASSES).toHaveLength(43);

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

  it('an explicit message replaces the described one', () => {
    const error = new CheckError('collector_unavailable', {}, { message: 'custom text' });

    expect(error.message).toBe('custom text');
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
