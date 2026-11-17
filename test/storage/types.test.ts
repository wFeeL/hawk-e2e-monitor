import { describe, expect, it } from 'vitest';
import { CHANNELS } from '../../src/notifications/types.js';
import { RUN_TRIGGERS } from '../../src/storage/types.js';

describe('runtime lists', () => {
  it('names the triggers', () => {
    expect(RUN_TRIGGERS).toEqual(['manual', 'schedule']);
  });

  it('names the notification channels', () => {
    expect(CHANNELS).toEqual(['webhook', 'loop']);
  });
});
