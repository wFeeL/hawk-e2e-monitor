import { CheckError } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';

/** The probe found what it looked for. */
export interface PollFound<T> {
  /** Discriminator. */
  kind: 'found';
  /** What was found. */
  value: T;
}

/** The API answered and the target is not there yet. */
export interface PollAbsent {
  /** Discriminator. */
  kind: 'absent';
}

/** The API failed to answer. */
export interface PollFailed {
  /** Discriminator. */
  kind: 'error';
  /** Why the API did not answer. */
  error: CheckError;
}

/** What one probe saw. */
export type PollObservation<T> = PollFound<T> | PollAbsent | PollFailed;

/** Schedule, jitter and abort of a poll. */
export interface PollOptions {
  /** Clock used for sleeping and timestamps. */
  clock: Clock;
  /** Deadline of the poll; also handed to every probe. */
  signal: AbortSignal;
  /** Waits between probes; the last value repeats. */
  scheduleMs?: readonly number[];
  /** Relative spread of each wait, 0.2 by default. */
  jitter?: number;
  /** Random source in [0, 1), `Math.random` by default. */
  random?: () => number;
}

/** The target was found. */
export interface PollResultFound<T> {
  /** Discriminator. */
  outcome: 'found';
  /** What was found. */
  value: T;
  /** Probes that counted, the finding one included. */
  attempts: number;
  /** Probes that failed before the finding one. */
  errors: number;
  /** Monotonic time before the first probe. */
  startedAtMs: number;
  /** Monotonic time when the target was found. */
  foundAtMs: number;
}

/** The API answered at least once and the target never appeared. */
export interface PollResultNotFound {
  /** Discriminator. */
  outcome: 'not_found';
  /** Probes that counted. */
  attempts: number;
  /** Probes that got an answer. */
  successes: number;
  /** Probes that failed. */
  errors: number;
  /** Monotonic time before the first probe. */
  startedAtMs: number;
  /** Monotonic time of the last answer. */
  lastSuccessAtMs: number;
}

/** The API never answered successfully. */
export interface PollResultApiError {
  /** Discriminator. */
  outcome: 'api_error';
  /** Probes that counted. */
  attempts: number;
  /** Probes that failed. */
  errors: number;
  /** Monotonic time before the first probe. */
  startedAtMs: number;
  /** Error of the last failed probe, or a timeout when none counted. */
  lastError: CheckError;
}

/** Final state of a poll. */
export type PollResult<T> = PollResultFound<T> | PollResultNotFound | PollResultApiError;

const FIRST_WAIT_MS = 500;
const SECOND_WAIT_MS = 1000;
const THIRD_WAIT_MS = 2000;
const FOURTH_WAIT_MS = 4000;
const LONG_WAIT_MS = 5000;
const DEFAULT_JITTER = 0.2;

/** Waits between probes: 0.5, 1, 2, 4, then 5 s. */
export const DEFAULT_POLL_SCHEDULE_MS: readonly number[] = [FIRST_WAIT_MS, SECOND_WAIT_MS, THIRD_WAIT_MS, FOURTH_WAIT_MS, LONG_WAIT_MS];

/**
 * Runs one probe and turns its failures into observations.
 * @param probe Probe to run.
 * @param signal Poll deadline.
 * @returns The observation, or `undefined` when an abort cut the probe off.
 * @throws A foreign exception while the signal is not aborted.
 */
async function observe<T>(probe: (signal: AbortSignal) => Promise<PollObservation<T>>, signal: AbortSignal): Promise<PollObservation<T> | undefined> {
  try {
    return await probe(signal);
  } catch (error) {
    if (signal.aborted) {
      return undefined;
    }

    if (error instanceof CheckError) {
      return { kind: 'error',
        error };
    }

    throw error;
  }
}

/**
 * Probes until the target is found or the signal aborts.
 * The first probe always runs; a probe that ends after the abort is not counted unless it found the target.
 * @param probe One look at the API.
 * @param options Clock, deadline, schedule and jitter.
 * @returns Found value, or the not-found or API-error summary.
 * @throws A non-`CheckError` thrown by the probe while the signal is not aborted, or an empty schedule.
 */
export async function pollUntil<T>(probe: (signal: AbortSignal) => Promise<PollObservation<T>>, options: PollOptions): Promise<PollResult<T>> {
  const { clock, signal } = options;
  const schedule = options.scheduleMs ?? DEFAULT_POLL_SCHEDULE_MS;
  const jitter = options.jitter ?? DEFAULT_JITTER;
  const random = options.random ?? Math.random;

  if (schedule.length === 0) {
    throw new Error('Poll schedule must not be empty');
  }

  const startedAtMs = clock.monotonicMs();
  let successes = 0;
  let errors = 0;
  let lastSuccessAtMs = startedAtMs;
  let lastError: CheckError | undefined;

  for (let i = 0; ; i += 1) {
    const observation = await observe(probe, signal);

    if (observation?.kind === 'found') {
      return { outcome: 'found',
        value: observation.value,
        attempts: successes + errors + 1,
        errors,
        startedAtMs,
        foundAtMs: clock.monotonicMs() };
    }

    if (observation !== undefined && !signal.aborted) {
      if (observation.kind === 'absent') {
        successes += 1;
        lastSuccessAtMs = clock.monotonicMs();
      } else {
        errors += 1;
        lastError = observation.error;
      }
    }

    if (signal.aborted) {
      break;
    }

    const base = schedule[Math.min(i, schedule.length - 1)] ?? 0;

    try {
      await clock.sleep(base * (1 + jitter * (2 * random() - 1)), signal);
    } catch {
      break;
    }
  }

  const attempts = successes + errors;

  if (successes > 0) {
    return { outcome: 'not_found',
      attempts,
      successes,
      errors,
      startedAtMs,
      lastSuccessAtMs };
  }

  return { outcome: 'api_error',
    attempts,
    errors,
    startedAtMs,
    lastError: lastError ?? new CheckError('api_unavailable', { code: 'TIMEOUT' }) };
}
