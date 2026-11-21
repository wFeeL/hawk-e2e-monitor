import { describe, expect, it } from 'vitest';
import { DEGRADED_CODES, STAGE_NAMES } from '../../src/engine/result.js';

describe('STAGE_NAMES', () => {
  it('lists the stages in execution order', () => {
    expect(STAGE_NAMES).toEqual([
      'collector_availability',
      'api_availability',
      'telegram_ready',
      'notification_setup',
      'project_created',
      'token_accepted',
      'release_uploaded',
      'release_saved',
      'collector_accept',
      'event_visible',
      'notification_formed',
      'telegram_delivered',
      'telegram_probe',
      'event_repeated',
      'threshold_formed',
      'cleanup',
      'garage_availability',
      'receiver_availability',
    ]);
  });
});

describe('DEGRADED_CODES', () => {
  it('names the degradation codes', () => {
    expect(DEGRADED_CODES).toEqual(['quota_usage', 'single_channel', 'accept_uncertain', 'js_worker_not_seen', 'grouping_pattern']);
  });
});
