import { Buffer } from 'node:buffer';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
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

/** An answer of the service. */
interface Answer {
  /** HTTP status. */
  status: number;
  /** Parsed JSON body, undefined when it was not JSON. */
  body: unknown;
}

const TIMEOUT = 'TIMEOUT';

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
 * Finds why a run was skipped.
 * @param body Run as the service sends it.
 * @returns The skip reason, else the first warning of the result, else an empty string.
 */
function skipReasonOf(body: unknown): string {
  const reason = textField(body, 'skipReason');

  if (reason !== '') {
    return reason;
  }

  const result = field(body, 'result');
  const warnings = field(result, 'warnings');
  const stages = field(result, 'stages');
  const first = Array.isArray(warnings) ? warnings.find((item: unknown) => typeof item === 'string') : undefined;

  if (typeof first === 'string') {
    return first;
  }

  for (const stage of Array.isArray(stages) ? stages as unknown[] : []) {
    const warning = field(field(stage, 'details'), 'warning');

    if (typeof warning === 'string') {
      return warning;
    }
  }

  return '';
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

  const reason = status === 'skipped' ? skipReasonOf(body) : [textField(body, 'errorClass'), textField(body, 'message')].filter(part => part !== '').join(': ');

  return { text: reason === '' ? status : `${status}: ${reason}`,
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
 * Sends one POST and reads the whole answer.
 * Node's own client is used because `fetch` gives up waiting for headers after 300 s, and a run that waits answers only when it ends.
 * @param url Address of the run.
 * @param token Bearer token.
 * @param timeoutMs Time for the whole answer.
 * @returns Status and parsed body.
 * @throws Error with `message` TIMEOUT when the time is up, or the error of the request.
 */
async function post(url: string, token: string, timeoutMs: number): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const req = request(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => {
      req.destroy(new Error(TIMEOUT));
    }, timeoutMs);

    req.on('response', (res: IncomingMessage) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);

        let body: unknown;

        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }

        resolve({ status: res.statusCode ?? 0,
          body });
      });
    });
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
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
    const { status, body } = await post(url, token, timeoutMs);

    return describeAnswer(status, body);
  } catch (error) {
    if (error instanceof Error && error.message === TIMEOUT) {
      return { text: `no answer: ${TIMEOUT}`,
        ok: false };
    }

    const code = field(error, 'code');
    const named = typeof code === 'string' ? code : error instanceof Error ? error.name : 'UNKNOWN';

    return { fatal: code === 'ECONNREFUSED' ? `serve is not running on ${address}` : `cannot reach serve on ${address}: ${named}` };
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
