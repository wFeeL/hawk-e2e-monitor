import { MINUTES_PER_HOUR, MS_PER_SECOND, SECONDS_PER_MINUTE } from './units.js';

const SECONDS_PRECISE_BELOW_MS = 59_950;
const ISO_DATE_TIME_LENGTH = 19;

/**
 * Formats a length of time for people.
 * @param ms Duration; negative counts as 0.
 * @returns `N ms` below one second, `10.0 s` below a minute, then `4m 15s` or `1h 5m 3s`.
 */
export function formatDuration(ms: number): string {
  const rounded = Math.max(0, Math.round(ms));

  if (rounded < MS_PER_SECOND) {
    return `${String(rounded)} ms`;
  }

  if (rounded < SECONDS_PRECISE_BELOW_MS) {
    return `${(rounded / MS_PER_SECOND).toFixed(1)} s`;
  }

  const total = Math.round(rounded / MS_PER_SECOND);
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = total % SECONDS_PER_MINUTE;

  return [hours > 0 ? `${String(hours)}h` : '', `${String(minutes)}m`, `${String(seconds)}s`]
    .filter(part => part !== '')
    .join(' ');
}

/**
 * Formats a point in time for people.
 * @param iso Time as an ISO string.
 * @returns `YYYY-MM-DD HH:MM:SS UTC`, without milliseconds.
 */
export function formatUtc(iso: string): string {
  return `${new Date(iso).toISOString()
.slice(0, ISO_DATE_TIME_LENGTH)
.replace('T', ' ')} UTC`;
}
