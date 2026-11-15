import type { RunResult } from '../engine/result.js';
import type { Redactor } from '../errors/redact.js';
import type { ErrorClass } from '../errors/taxonomy.js';
import type { ScenarioName } from '../scenarios/send-and-receive/plan.js';
import type { AlertStateRow } from '../storage/history.js';
import type { RunRow } from '../storage/types.js';
import type { AlertKind } from './state.js';

/** Longest alert text codex.bot gets, counted after escaping. */
export const ALERT_TEXT_LIMIT = 3500;

const ELLIPSIS = '…';
const BOLD_TAGS_LENGTH = '<b></b>'.length;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const WARNING_CLASSES: readonly ErrorClass[] = ['quota_exhausted', 'rate_limited'];
const TITLES: ReadonlyMap<AlertKind, string> = new Map([
  ['failed', 'FAILED'],
  ['still_failing', 'STILL FAILING, now'],
  ['recovered', 'RECOVERED'],
  ['recovered_degraded', 'RECOVERED, degraded'],
  ['degraded', 'DEGRADED'],
]);
const ESCAPES: ReadonlyMap<string, string> = new Map([['&', '&amp;'], ['<', '&lt;'], ['>', '&gt;']]);

/** What the text of an alert is built from. */
export interface AlertTextInput {
  /** Kind of the transition. */
  kind: AlertKind;
  /** Id of this monitor. */
  instanceId: string;
  /** Scenario of the run. */
  scenario: ScenarioName;
  /** Run that caused the transition. */
  row: RunRow;
  /** State after the transition. */
  state: AlertStateRow;
  /** Full result of the run, when there is one. */
  result?: RunResult;
  /** Current time, ISO. */
  now: string;
}

/**
 * Escapes the characters codex.bot reads as HTML.
 * @param text Plain text.
 * @returns Text with `&`, `<` and `>` replaced by entities.
 */
export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>]/gu, char => ESCAPES.get(char) ?? char);
}

/**
 * Counts the characters a text has after escaping.
 * @param text Plain text.
 * @returns Length of `escapeHtml(text)`.
 */
function escapedLength(text: string): number {
  let length = 0;

  for (const char of text) {
    length += (ESCAPES.get(char) ?? char).length;
  }

  return length;
}

/**
 * Cuts a text so that its escaped form fits a budget, never inside an entity.
 * @param text Plain text.
 * @param budget Characters allowed after escaping.
 * @returns The text, or its start followed by an ellipsis.
 */
function fit(text: string, budget: number): string {
  if (escapedLength(text) <= budget) {
    return text;
  }

  let kept = '';
  let used = ELLIPSIS.length;

  for (const char of text) {
    used += (ESCAPES.get(char) ?? char).length;

    if (used > budget) {
      break;
    }

    kept += char;
  }

  return kept + ELLIPSIS;
}

/**
 * Formats a length of time for people.
 * @param ms Duration; negative counts as 0.
 * @returns Text like `1h 5m 3s`, without leading zero units.
 */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = total % SECONDS_PER_MINUTE;

  return [hours > 0 ? `${String(hours)}h` : '', hours > 0 || minutes > 0 ? `${String(minutes)}m` : '', `${String(seconds)}s`]
    .filter(part => part !== '')
    .join(' ');
}

/**
 * Picks the level word of a header.
 * @param input Input of the text.
 * @returns `outage` or `warning` for failures and degradation, undefined for recoveries.
 */
function levelOf(input: AlertTextInput): string | undefined {
  switch (input.kind) {
    case 'failed':
    case 'still_failing':
      return input.row.errorClass !== undefined && WARNING_CLASSES.includes(input.row.errorClass) ? 'warning' : 'outage';
    case 'degraded':
      return 'warning';
    case 'recovered':
    case 'recovered_degraded':
      return undefined;
  }
}

/**
 * Describes the episode a recovery ends.
 * @param input Input of the text.
 * @returns The `after <n> failed runs, ...` line, or undefined when the state has no episode.
 */
function episodeLine(input: AlertTextInput): string | undefined {
  const { state } = input;

  if (state.episodeStartedAt === undefined || state.episodeFailures === 0) {
    return undefined;
  }

  const count = state.episodeFailures;
  const length = formatDuration(Date.parse(input.now) - Date.parse(state.episodeStartedAt));

  return `after ${String(count)} failed ${count === 1 ? 'run' : 'runs'}, ${length} (since ${state.episodeStartedAt})`;
}

/**
 * Lists the latencies the run measured.
 * @param row Run row.
 * @param result Full result of the run.
 * @returns The `event latency: ...` line, or undefined when nothing was measured.
 */
function latencyLine(row: RunRow, result: RunResult | undefined): string | undefined {
  const parts = [
    row.eventLatencyMs === undefined ? undefined : `event latency: ${String(row.eventLatencyMs)} ms`,
    result?.notification?.webhook === undefined ? undefined : `webhook ${String(result.notification.webhook.latencyMs)} ms`,
    result?.notification?.loop === undefined ? undefined : `loop ${String(result.notification.loop.latencyMs)} ms`,
  ].filter(part => part !== undefined);

  return parts.length === 0 ? undefined : parts.join(' | ');
}

/** One line of the text with its place in the cutting order. */
interface Line {
  /** Plain text of the line, already masked. */
  text: string;
  /** Lines with a higher number are cut first; absent for lines that stay whole. */
  cutOrder?: number;
}

/**
 * Collects the lines below the header.
 * @param input Input of the text.
 * @returns Lines in order, plain.
 */
function bodyLines(input: AlertTextInput): Line[] {
  const { kind, row, state, result } = input;
  const run: Line = { text: `run: ${row.runId} #${String(row.sequence)} | ${row.startedAt}` };
  const codes: Line[] = state.degraded.length === 0 ? [] : [{ text: `degraded: ${state.degraded.join(', ')}` }];
  const warnings: Line[] = (result?.warnings ?? []).map(text => ({ text }));
  const episode = episodeLine(input);
  const recovery: Line[] = episode === undefined ? [] : [{ text: episode }];

  switch (kind) {
    case 'failed':
    case 'still_failing': {
      const stages = row.stages.map(stage => `${stage.name} ${String(stage.durationMs)} ms ${stage.status}`).join(', ');
      const latency = latencyLine(row, result);

      return [
        { text: `stage: ${row.failedStage ?? '-'} | class: ${row.errorClass ?? '-'} | culprit: ${row.culprit ?? '-'}` },
        { text: row.message ?? '',
          cutOrder: 1 },
        run,
        { text: `stages: ${stages}`,
          cutOrder: 2 },
        ...latency === undefined ? [] : [{ text: latency }],
      ];
    }
    case 'recovered':
      return [...recovery, run];
    case 'recovered_degraded':
      return [...recovery, ...codes, ...warnings, run];
    case 'degraded':
      return [...codes, ...warnings, run];
  }
}

/**
 * Builds the HTML text of an alert for codex.bot.
 * Every fragment is masked first, then the text is cut to fit `ALERT_TEXT_LIMIT` after escaping (the error text first, then the stages), then escaped, and the markup is added last.
 * @param input What the text is built from.
 * @param redact Masks secrets in plain text.
 * @returns Text of at most `ALERT_TEXT_LIMIT` characters.
 */
export function alertText(input: AlertTextInput, redact: Redactor): string {
  const title = TITLES.get(input.kind) ?? '';
  const level = levelOf(input);
  const head = `${input.scenario} [e2e:${input.instanceId}]${level === undefined ? '' : ` | ${level}`}`;
  const headText = redact(head);
  const lines = bodyLines(input).map(line => ({ ...line,
    text: redact(line.text) }));
  const breaks = lines.length;
  let excess = BOLD_TAGS_LENGTH + title.length + 1 + escapedLength(headText) + breaks
    + lines.reduce((sum, line) => sum + escapedLength(line.text), 0) - ALERT_TEXT_LIMIT;

  for (const line of lines.filter(item => item.cutOrder !== undefined).toSorted((left, right) => (left.cutOrder ?? 0) - (right.cutOrder ?? 0))) {
    if (excess <= 0) {
      break;
    }

    const before = escapedLength(line.text);

    line.text = fit(line.text, Math.max(ELLIPSIS.length, before - excess));
    excess -= before - escapedLength(line.text);
  }

  return [`<b>${title}</b> ${escapeHtml(headText)}`, ...lines.map(line => escapeHtml(line.text))].join('\n');
}
