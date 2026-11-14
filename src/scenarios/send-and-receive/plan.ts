import { randomInt } from 'node:crypto';
import type { Transport } from '../../clients/collector.js';
import type { Config } from '../../config/load.js';
import type { TransportMode } from '../../config/schema.js';

const RUN_ID_LETTERS = 15;
const ALPHABET_SIZE = 26;
const FIRST_LETTER_CODE = 97;
const HTTP_CATCHER = 'errors/nodejs';
const WS_CATCHER = 'errors/javascript';

/** Name of the scenario in titles and results. */
export const SCENARIO_NAME = 'send-and-receive-event';

/** What the event carries in its `context`, so a mangled title can still be recognized. */
export interface RunContextPayload {
  /** Id of the run. */
  runId: string;
  /** Id of the monitor instance. */
  instanceId: string;
  /** Scenario name. */
  scenario: typeof SCENARIO_NAME;
  /** Transport of the first send. */
  transport: Transport;
  /** Run number. */
  sequence: number;
}

/** Everything decided about a run before it starts. */
export interface RunPlan {
  /** Random id of the run. */
  runId: string;
  /** Run number. */
  sequence: number;
  /** Transport of the event. */
  transport: Transport;
  /** Catcher type that goes with the transport. */
  catcherType: string;
  /** Whether stage 5 sends the event a second time. */
  repeat: boolean;
  /** Title of the event. */
  title: string;
  /** Context of the event. */
  context: RunContextPayload;
}

/** Overrides of the computed plan. */
export interface PlanOptions {
  /** Run number. */
  sequence: number;
  /** Forces the transport. */
  transport?: Transport;
  /** Forces the repeat. */
  repeat?: boolean;
}

/** Source of `count` random lowercase letters. */
export type RandomLetters = (count: number) => string;

/**
 * Picks the transport for a run number.
 * @param sequence Run number from 1.
 * @param mode Configured mode.
 * @returns HTTP for odd numbers and WebSocket for even ones in `alternate`, the fixed one otherwise.
 */
export function chooseTransport(sequence: number, mode: TransportMode): Transport {
  if (mode === 'alternate') {
    return sequence % 2 === 1 ? 'http' : 'ws';
  }

  return mode;
}

/**
 * Tells whether the run repeats the event.
 * Every N-th run of a transport repeats, so both paths get repeats whatever the parity of N.
 * @param sequence Run number from 1.
 * @param mode Configured mode.
 * @param everyN Repeat period; 0 turns repeats off.
 * @returns True when stage 5 runs.
 */
export function shouldRepeat(sequence: number, mode: TransportMode, everyN: number): boolean {
  if (everyN === 0) {
    return false;
  }

  const position = mode === 'alternate' ? Math.ceil(sequence / 2) : sequence;

  return position % everyN === 0;
}

/**
 * Draws random lowercase letters from the system source.
 * @param count How many letters.
 * @returns String of `count` letters a-z.
 */
function systemLetters(count: number): string {
  return Array.from({ length: count },
    () => String.fromCodePoint(FIRST_LETTER_CODE + randomInt(0, ALPHABET_SIZE))).join('');
}

/**
 * Creates a run id: `r` and letters only, since digits can fall under the grouper's card number filter.
 * @param randomLetters Source of letters, for tests.
 * @returns Id like `rabcdefghijklmno`.
 */
export function createRunId(randomLetters: RandomLetters = systemLetters): string {
  return `r${randomLetters(RUN_ID_LETTERS)}`;
}

/**
 * Builds the event title.
 * @param instanceId Id of this monitor, unique among instances.
 * @param runId Random id from `createRunId`.
 * @returns Title that starts with `[e2e:<instanceId>] <runId> `.
 */
export function buildTitle(instanceId: string, runId: string): string {
  return `[e2e:${instanceId}] ${runId} ${SCENARIO_NAME}`;
}

/**
 * Decides everything about a run up front.
 * @param config Validated configuration.
 * @param options Run number and optional overrides.
 * @param randomLetters Source of letters for the run id, for tests.
 * @returns Transport, catcher type, repeat flag, title and context of the run.
 */
export function planRun(config: Config, options: PlanOptions, randomLetters?: RandomLetters): RunPlan {
  const { sequence } = options;
  const transport = options.transport ?? chooseTransport(sequence, config.transportMode);
  const runId = createRunId(randomLetters);

  return {
    runId,
    sequence,
    transport,
    catcherType: transport === 'http' ? HTTP_CATCHER : WS_CATCHER,
    repeat: options.repeat ?? shouldRepeat(sequence, config.transportMode, config.repeatEveryNRuns),
    title: buildTitle(config.instanceId, runId),
    context: { runId,
      instanceId: config.instanceId,
      scenario: SCENARIO_NAME,
      transport,
      sequence },
  };
}
