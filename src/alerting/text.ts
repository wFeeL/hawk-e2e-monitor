import type { RunResult } from '../engine/result.js';
import type { Redactor } from '../errors/redact.js';
import type { ErrorClass } from '../errors/taxonomy.js';
import type { ScenarioName } from '../scenarios/names.js';
import type { AlertStateRow } from '../storage/history.js';
import type { RunRow } from '../storage/types.js';
import type { AlertKind } from './state.js';
import { formatDuration, formatUtc } from '../time/format.js';

/** Longest alert text codex.bot gets, counted after escaping. */
export const ALERT_TEXT_LIMIT = 3500;

const ELLIPSIS = '…';
const WARNING_CLASSES: readonly ErrorClass[] = ['quota_exhausted', 'rate_limited'];
const STORAGE_MARK = '⚠️';

/** Status mark and title of an alert kind. */
interface KindTitle {
  /** Emoji that opens the text. */
  mark: string;
  /** Bold title. */
  title: string;
}

const TITLES: ReadonlyMap<AlertKind, KindTitle> = new Map([
  ['failed', { mark: '🔴',
    title: 'FAILED' }],
  ['still_failing', { mark: '🟠',
    title: 'STILL FAILING' }],
  ['recovered', { mark: '🟢',
    title: 'RECOVERED' }],
  ['recovered_degraded', { mark: '🟢',
    title: 'RECOVERED, degraded' }],
  ['degraded', { mark: '🟡',
    title: 'DEGRADED' }],
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
 * Cuts a text so that its escaped form fits a limit, never inside an entity.
 * @param text Plain text.
 * @param limit Characters allowed after escaping.
 * @returns The text, or its start followed by an ellipsis.
 */
function fit(text: string, limit: number): string {
  if (escapedLength(text) <= limit) {
    return text;
  }

  let kept = '';
  let used = ELLIPSIS.length;

  for (const char of text) {
    used += (ESCAPES.get(char) ?? char).length;

    if (used > limit) {
      break;
    }

    kept += char;
  }

  return kept + ELLIPSIS;
}

/**
 * Picks the level word of the second line.
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

/** One line of the text: plain parts and one optional bold word, all still unescaped. */
interface Line {
  /** Plain text before the bold word, such as a status mark. */
  lead?: string;
  /** Bold word; the tags are added when the text is rendered. */
  bold?: string;
  /** Plain text after the bold word. */
  text: string;
  /** Lines with a lower number are cut first; absent for lines that stay whole. */
  cutOrder?: number;
}

/**
 * Describes the episode a recovery ends.
 * @param input Input of the text.
 * @returns The episode lines, or none when the state has no episode.
 */
function episodeLines(input: AlertTextInput): Line[] {
  const { state } = input;

  if (state.episodeStartedAt === undefined || state.episodeFailures === 0) {
    return [];
  }

  const count = state.episodeFailures;
  const length = formatDuration(Date.parse(input.now) - Date.parse(state.episodeStartedAt));

  return [{ text: `after ${String(count)} failed ${count === 1 ? 'run' : 'runs'}, down ${length}` },
    { text: `(since ${formatUtc(state.episodeStartedAt)})` }];
}

/**
 * Lists the latencies the run measured.
 * @param row Run row.
 * @param result Full result of the run.
 * @returns The latency line, or none when nothing was measured.
 */
function latencyLines(row: RunRow, result: RunResult | undefined): Line[] {
  const parts = [
    row.eventLatencyMs === undefined ? undefined : `event latency ${formatDuration(row.eventLatencyMs)}`,
    result?.notification?.webhook === undefined ? undefined : `webhook ${formatDuration(result.notification.webhook.latencyMs)}`,
    result?.notification?.loop === undefined ? undefined : `loop ${formatDuration(result.notification.loop.latencyMs)}`,
  ].filter(part => part !== undefined);

  return parts.length === 0 ? [] : [{ text: parts.join(' | ') }];
}

/**
 * Lists the stages that ran, as `name duration`.
 * @param row Run row.
 * @param label Word in front of the list.
 * @param upTo Name of the stage to stop before, or undefined for all stages.
 * @returns The stages line, or none when no stage ran.
 */
function stageLines(row: RunRow, label: string, upTo?: string): Line[] {
  const end = upTo === undefined ? -1 : row.stages.findIndex(stage => stage.name === upTo);
  const ran = (end === -1 ? row.stages : row.stages.slice(0, end)).filter(stage => stage.status !== 'skipped');

  return ran.length === 0
    ? []
    : [{ text: `${label}: ${ran.map(stage => `${stage.name} ${formatDuration(stage.durationMs)}`).join(', ')}`,
        cutOrder: 2 }];
}

/**
 * Builds the first block: status mark, title, scenario and instance.
 * @param input Input of the text.
 * @returns Two lines.
 */
function headerBlock(input: AlertTextInput): Line[] {
  const { mark, title } = TITLES.get(input.kind) ?? { mark: '',
    title: '' };
  const level = levelOf(input);

  return [{ lead: `${mark} `,
    bold: title,
    text: ` ${input.scenario}` },
  { text: `instance ${input.instanceId}${level === undefined ? '' : ` | ${level}`}` }];
}

/**
 * Builds the block that says what failed.
 * @param input Input of the text.
 * @returns The failed stage with its time, class and culprit, and the error message.
 */
function failureBlock(input: AlertTextInput): Line[] {
  const { row } = input;
  const failed = row.stages.find(stage => stage.name === row.failedStage);
  const after = failed === undefined ? '' : ` after ${formatDuration(failed.durationMs)}`;

  return [{ bold: row.failedStage ?? 'run',
    text: ` failed${after}` },
  { text: `class ${row.errorClass ?? '-'} | culprit ${row.culprit ?? '-'}` },
  { text: row.message ?? '',
    cutOrder: 1 }];
}

/**
 * Builds the block that names the run.
 * @param row Finished run.
 * @returns The sequence with the run id, and the start time.
 */
function runBlock(row: RunRow): Line[] {
  return [{ text: `run #${String(row.sequence)} ${row.runId}` },
    { text: `started ${formatUtc(row.startedAt)}` }];
}

/**
 * Collects the blocks below the header.
 * @param input Input of the text.
 * @returns Blocks in order; each block is shown as consecutive lines.
 */
function bodyBlocks(input: AlertTextInput): Line[][] {
  const { kind, row, state, result } = input;
  const codes: Line[] = state.degraded.length === 0 ? [] : [{ text: `degraded: ${state.degraded.join(', ')}` }];
  // Later warnings are cut first, so the first one stays readable the longest.
  const found = result?.warnings ?? [];
  const warnings: Line[] = found.map((text, index) => ({ text,
    cutOrder: found.length - index }));
  const blocks: Line[][] = [];

  switch (kind) {
    case 'failed':
    case 'still_failing':
      blocks.push(failureBlock(input), runBlock(row), [...latencyLines(row, result), ...stageLines(row, 'before', row.failedStage)]);
      break;
    case 'recovered':
      blocks.push(episodeLines(input), runBlock(row), [...latencyLines(row, result), ...stageLines(row, 'stages')]);
      break;
    case 'recovered_degraded':
      blocks.push(episodeLines(input), [...codes, ...warnings], runBlock(row), [...latencyLines(row, result), ...stageLines(row, 'stages')]);
      break;
    case 'degraded':
      blocks.push([...codes, ...warnings], runBlock(row), [...latencyLines(row, result), ...stageLines(row, 'stages')]);
      break;
  }

  return blocks.filter(block => block.length > 0);
}

/**
 * Turns a line into HTML.
 * @param line Masked line.
 * @returns Escaped text with the bold word in tags.
 */
function renderLine(line: Line): string {
  return `${escapeHtml(line.lead ?? '')}${line.bold === undefined ? '' : `<b>${escapeHtml(line.bold)}</b>`}${escapeHtml(line.text)}`;
}

/**
 * Joins blocks into text: lines by a line break, blocks by an empty line.
 * @param blocks Masked blocks.
 * @returns HTML text.
 */
function renderBlocks(blocks: readonly (readonly Line[])[]): string {
  return blocks.map(block => block.map(renderLine).join('\n')).join('\n\n');
}

/**
 * Masks every part of a block.
 * @param block Block of plain lines.
 * @param redact Masks secrets in plain text.
 * @returns The block with masked parts.
 */
function maskBlock(block: readonly Line[], redact: Redactor): Line[] {
  return block.map(line => ({ ...line,
    ...line.bold === undefined ? {} : { bold: redact(line.bold) },
    text: redact(line.text) }));
}

/**
 * Builds the HTML text of an alert for codex.bot.
 * Every fragment is masked first, then the text is cut to fit `ALERT_TEXT_LIMIT` after escaping (the error text and the warnings first, then the stages), then escaped, and the markup is added last.
 * @param input What the text is built from.
 * @param redact Masks secrets in plain text.
 * @returns Text of at most `ALERT_TEXT_LIMIT` characters, in blocks separated by an empty line.
 */
export function alertText(input: AlertTextInput, redact: Redactor): string {
  const blocks = [headerBlock(input), ...bodyBlocks(input)].map(block => maskBlock(block, redact));
  let excess = renderBlocks(blocks).length - ALERT_TEXT_LIMIT;

  for (const line of blocks.flat().filter(item => item.cutOrder !== undefined)
    .toSorted((left, right) => (left.cutOrder ?? 0) - (right.cutOrder ?? 0))) {
    if (excess <= 0) {
      break;
    }

    const before = escapedLength(line.text);

    line.text = fit(line.text, Math.max(ELLIPSIS.length, before - excess));
    excess -= before - escapedLength(line.text);
  }

  return renderBlocks(blocks);
}

/**
 * Builds the alert about a broken alert storage; it is sent directly, so it stays short.
 * @param instanceId Id of this monitor.
 * @param error Description of the storage failure.
 * @param redact Masks secrets in plain text.
 * @returns HTML text.
 */
export function storageFailingText(instanceId: string, error: string, redact: Redactor): string {
  return renderBlocks([
    [{ lead: `${STORAGE_MARK} `,
      bold: 'STORAGE FAILING',
      text: '' },
    { text: `instance ${redact(instanceId)}` }],
    [{ text: redact(error) }],
  ]);
}

/**
 * Builds a plain alert for a transition whose full text could not be built.
 * @param kind Kind of the transition.
 * @param scenario Scenario of the run.
 * @param instanceId Id of this monitor.
 * @returns HTML text; nothing in it needs masking.
 */
export function plainAlertText(kind: AlertKind, scenario: ScenarioName, instanceId: string): string {
  const { mark, title } = TITLES.get(kind) ?? { mark: '',
    title: kind };

  return renderBlocks([
    [{ lead: `${mark} `,
      bold: title,
      text: ` ${scenario}` },
    { text: `instance ${instanceId}` }],
    [{ text: 'The alert text could not be built, see the monitor log.' }],
  ]);
}
