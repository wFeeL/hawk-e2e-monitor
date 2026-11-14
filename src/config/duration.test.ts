import { describe, expect, it } from 'vitest';
import { durationMs } from './duration.js';

describe('durationMs', () => {
  it('uses default when missing', () => {
    expect(durationMs(5000).safeParse(undefined).data).toBe(5000);
  });

  it('parses whole milliseconds', () => {
    expect(durationMs(5000).safeParse('1500').data).toBe(1500);
  });

  it('accepts the maximum', () => {
    expect(durationMs(5000).safeParse('2147483647').data).toBe(2147483647);
  });

  it('rejects above the maximum', () => {
    expect(durationMs(5000).safeParse('2147483648').error?.issues[0]?.message).toBe('must not exceed 2147483647 ms');
  });

  it('rejects zero', () => {
    expect(durationMs(5000).safeParse('0').error?.issues[0]?.message).toBe('must be greater than 0');
  });

  it.each(['1.5', '10s', '-1'])('rejects fractions and units: %s', (value) => {
    expect(durationMs(5000).safeParse(value).error?.issues[0]?.message).toBe('must be a whole number of milliseconds');
  });

  it('accepts zero when allowed', () => {
    expect(durationMs(5000, { allowZero: true }).safeParse('0').data).toBe(0);
  });

  it('still rejects fractions when zero is allowed', () => {
    expect(durationMs(5000, { allowZero: true }).safeParse('1.5').error?.issues[0]?.message).toBe('must be a whole number of milliseconds');
  });
});
