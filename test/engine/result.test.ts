import { describe, expect, it } from 'vitest';
import { STAGE_NAMES } from '../../src/engine/result.js';

describe('STAGE_NAMES', () => {
  it('lists the stages in execution order', () => {
    expect(STAGE_NAMES).toEqual(['collector_availability', 'api_availability', 'notification_setup', 'collector_accept', 'event_visible', 'notification_formed', 'event_repeated', 'cleanup']);
  });
});
