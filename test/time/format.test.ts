import { describe, expect, it } from 'vitest';
import { formatDuration, formatUtc } from '../../src/time/format.js';

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [4.4, '4 ms'],
    [710.652_002, '711 ms'],
    [999.4, '999 ms'],
    [999.6, '1.0 s'],
    [1000, '1.0 s'],
    [10_001, '10.0 s'],
    [10_049, '10.0 s'],
    [10_050, '10.1 s'],
    [59_949, '59.9 s'],
    [59_950, '1m 0s'],
    [60_000, '1m 0s'],
    [255_000, '4m 15s'],
    [3_903_000, '1h 5m 3s'],
    [7_200_000, '2h 0m 0s'],
    [-5, '0 ms'],
  ])('%d ms is %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('formatUtc', () => {
  it('drops the milliseconds and the T, and names the zone', () => {
    expect(formatUtc('2026-11-15T15:35:37.123Z')).toBe('2026-11-15 15:35:37 UTC');
    expect(formatUtc('2026-03-10T12:00:00.000Z')).toBe('2026-03-10 12:00:00 UTC');
  });

  it('shows another offset in UTC', () => {
    expect(formatUtc('2026-03-10T15:00:00+03:00')).toBe('2026-03-10 12:00:00 UTC');
  });
});
