import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/notifications/types.js';
import { DEGRADED_CODES, RUN_TRIGGERS } from '../../src/storage/types.js';

describe('runtime lists', () => {
  it('names the degradation codes and triggers', () => {
    expect(DEGRADED_CODES).toEqual(['quota_usage', 'single_channel']);
    expect(RUN_TRIGGERS).toEqual(['manual', 'schedule']);
  });

  it('names the notification channels', () => {
    expect(CHANNELS).toEqual(['webhook', 'loop']);
  });
});
