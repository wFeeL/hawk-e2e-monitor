import type { RunCommand } from '../cli.js';
import type { Config } from '../config/load.js';
import { scenarioSettings } from '../config/scenario.js';
import type { ScenarioName } from '../scenarios/names.js';
import { HttpStatus } from '../net/http-status.js';
import { formatDuration } from '../time/format.js';
import type { CheckIo } from './check.js';

const EXTRA_WAIT_MS = 30_000;
const PAD = 2;
const EXIT_NOT_OK = 1;
const EXIT_CANNOT_ASK = 2;

/** A line to print for one scenario. */
interface Line {
  /** Text after the name. */
  text: string;
  /** Whether the run was ok. */
  ok: boolean;
}

/** A failure that stops the command. */
interface Fatal {
  /** Message for stderr. */
  fatal: string;
}

/** The part of a `fetch` rejection's cause that tells why it failed. */
interface ErrorCause {
  /** System error code such as `ECONNREFUSED`. */
  code?: unknown;
}

/** Test hooks of the command. */
export interface RunDeps {
  /** Replaces the whole request timeout of a scenario. */
  requestTimeoutMs?: (scenario: ScenarioName) => number;
}

/**
 * Turns the address the service listens on into one a client can connect to.
 * @param host Configured host.
 * @returns The host, with a wildcard replaced by loopback.
 */
function connectHost(host: string): string {
  if (host === '0.0.0.0') {
    return '127.0.0.1';
  }

  return host === '::' ? '::1' : host;
}

/**
 * Reads a field of a parsed body.
 * @param body Parsed JSON of any shape.
 * @param key Field name.
 * @returns The value, or undefined when the body is not an object.
 */
function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

/**
 * Reads a field as text.
 * @param body Parsed JSON of any shape.
 * @param key Field name.
 * @returns The value as text, or an empty string when it is not a string or a number.
 */
function textField(body: unknown, key: string): string {
  const value = field(body, key);

  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

/**
 * Describes a finished run (answer 200).
 * @param body Run as the service sends it.
 * @returns Text after the name, and whether the run was ok.
 */
function finished(body: unknown): Line {
  const status = textField(body, 'status');

  if (status === 'ok') {
    const duration = field(body, 'durationMs');

    return { text: typeof duration === 'number' ? `ok  ${formatDuration(duration)}` : 'ok',
      ok: true };
  }

  if (status === 'failed') {
    const stage = textField(body, 'failedStage');
    const errorClass = textField(body, 'errorClass');
    const message = textField(body, 'message');

    return { text: `failed${stage === '' ? '' : ` at ${stage}`}${errorClass === '' ? '' : `: ${errorClass}`}${message === '' ? '' : `: ${message}`}`,
      ok: false };
  }

  return { text: status,
    ok: false };
}

/**
 * Describes an answer of the service.
 * @param status HTTP status.
 * @param body Parsed body, undefined when it was not JSON.
 * @returns Text after the name, whether the run was ok, or a fatal message that stops the command.
 */
function describeAnswer(status: number, body: unknown): Line | Fatal {
  switch (status) {
    case HttpStatus.ok:
      return finished(body);
    case HttpStatus.accepted:
      return { text: `started (${textField(body, 'runId')}), still running; see history`,
        ok: false };
    case HttpStatus.unauthorized:
      return { fatal: 'the service rejected RUN_TOKEN; is it the same as the one serve was started with?' };
    case HttpStatus.notFound:
      return { text: 'not enabled in SCENARIOS',
        ok: false };
    case HttpStatus.conflict:
      return { text: `skipped: already running (${textField(body, 'runningRunId')})`,
        ok: false };
    case HttpStatus.tooManyRequests:
      return { text: `skipped: manual run limit, retry in ${textField(body, 'retryAfterSeconds')} s`,
        ok: false };
    default:
      return { text: `unexpected HTTP ${String(status)}`,
        ok: false };
  }
}

/**
 * Asks the service for one run.
 * @param url Address of the run.
 * @param token Bearer token.
 * @param timeoutMs Time for the whole answer.
 * @param address Host and port, for the message when nobody listens.
 * @returns What to print, or a fatal message.
 */
async function ask(url: string, token: string, timeoutMs: number, address: string): Promise<Line | Fatal> {
  try {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: unknown;

    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    return describeAnswer(response.status, body);
  } catch (error) {
    const cause = error instanceof Error ? (error.cause as ErrorCause | undefined) : undefined;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;

    if (code === 'ECONNREFUSED') {
      return { fatal: `serve is not running on ${address}` };
    }

    if (error instanceof Error && error.name === 'TimeoutError') {
      return { text: 'no answer: TIMEOUT',
        ok: false };
    }

    return { text: `no answer: ${code ?? (error instanceof Error ? error.name : 'UNKNOWN')}`,
      ok: false };
  }
}

/**
 * Asks the running service to run scenarios one after another and prints one line for each.
 * @param command Scenarios asked for; empty means every enabled one.
 * @param config Configuration with the token, the address of the internal server and the enabled scenarios.
 * @param io Output.
 * @param deps Test hooks.
 * @returns 0 when every run was ok, 1 when any was not, 2 when the service could not be asked.
 */
export async function runRunCommand(command: RunCommand, config: Config, io: CheckIo, deps: RunDeps = {}): Promise<number> {
  const { token } = config.monitoring.manual;
  const enabled = config.monitoring.scenarios;

  if (token === undefined) {
    io.stderr('RUN_TOKEN is not set, so the service takes no manual runs\n');

    return EXIT_CANNOT_ASK;
  }

  const scenarios = command.scenarios.length === 0 ? enabled : command.scenarios;
  const missing = scenarios.find(name => !enabled.includes(name));

  if (missing !== undefined) {
    io.stderr(`${missing} is not enabled in SCENARIOS\n`);

    return EXIT_CANNOT_ASK;
  }

  const host = connectHost(config.internal.host);
  const address = `${host}:${String(config.internal.port)}`;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const width = Math.max(...scenarios.map(name => name.length)) + PAD;
  let allOk = true;

  for (const scenario of scenarios) {
    const timeoutMs = deps.requestTimeoutMs?.(scenario) ?? scenarioSettings(config, scenario).watchdogMs + EXTRA_WAIT_MS;
    const outcome = await ask(`http://${urlHost}:${String(config.internal.port)}/runs/${scenario}?wait=true`, token, timeoutMs, address);

    if ('fatal' in outcome) {
      io.stderr(`${outcome.fatal}\n`);

      return EXIT_CANNOT_ASK;
    }

    io.stdout(`${scenario.padEnd(width)}${outcome.text}\n`);
    allOk &&= outcome.ok;
  }

  return allOk ? 0 : EXIT_NOT_OK;
}
