import process from 'node:process';
import { LOG_LEVELS } from '../config/schema.js';
import type { LogLevel } from '../config/schema.js';

const MAX_CAUSE_DEPTH = 5;
const DEPTH_EXCEEDED = '[cause depth exceeded]';

/** Structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/** Writes JSON log lines at four levels. */
export interface Logger {
  /**
   * Writes a debug line.
   * @param msg Message.
   * @param fields Extra fields.
   */
  debug(msg: string, fields?: LogFields): void;
  /**
   * Writes an info line.
   * @param msg Message.
   * @param fields Extra fields.
   */
  info(msg: string, fields?: LogFields): void;
  /**
   * Writes a warning line.
   * @param msg Message.
   * @param fields Extra fields.
   */
  warn(msg: string, fields?: LogFields): void;
  /**
   * Writes an error line.
   * @param msg Message.
   * @param fields Extra fields.
   */
  error(msg: string, fields?: LogFields): void;
}

/** Settings of `createLogger`. */
export interface LoggerOptions {
  /** Lines below this level are dropped. */
  level: LogLevel;
  /** Clock; defaults to the system time. */
  now?: () => Date;
  /** Sink for one line without a trailing newline; defaults to stdout. */
  write?: (line: string) => void;
}

/**
 * Converts an error into a plain object, following `cause` up to a fixed depth.
 * Node's `fetch failed` hides the real reason in `cause`, so it must be logged.
 * @param error Value to serialize; non-errors are returned unchanged.
 * @param depth Position in the cause chain, 0 for the outermost error.
 * @returns Plain object for errors, the input otherwise.
 */
export function serializeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };

  if ('code' in error && error.code !== undefined) {
    result.code = error.code;
  }
  result.stack = error.stack;
  if (error.cause !== undefined) {
    result.cause = depth + 1 >= MAX_CAUSE_DEPTH ? DEPTH_EXCEEDED : serializeError(error.cause, depth + 1);
  }

  return result;
}

/**
 * Builds a `JSON.stringify` replacer for log values.
 * Ancestors are tracked through `this` so shared references stay intact.
 * @returns Replacer that handles errors, cycles and bigint.
 */
function createReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const ancestors: unknown[] = [];

  return function replacer(this: unknown, _key: string, value: unknown): unknown {
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }

    if (typeof value === 'bigint') {
      return value.toString();
    }

    const converted = serializeError(value);

    if (typeof converted === 'object' && converted !== null) {
      if (ancestors.includes(converted)) {
        return '[Circular]';
      }
      ancestors.push(converted);
    }

    return converted;
  };
}

/**
 * Picks the message of a caught value.
 * @param error Caught value.
 * @returns Human-readable text.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

/**
 * Creates a logger that writes one JSON object per line and never throws.
 * @param options Level, clock and sink.
 * @returns Logger that filters by level and writes through the configured sink.
 */
export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? ((): Date => new Date());
  const write = options.write ?? ((line: string): void => {
    process.stdout.write(`${line}\n`);
  });
  const threshold = LOG_LEVELS.indexOf(options.level);

  const log = (level: LogLevel, msg: string, fields: LogFields | undefined): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) {
      return;
    }

    try {
      const ts = now().toISOString();
      let line: string;

      try {
        line = JSON.stringify({ ...fields,
          ts,
          level,
          msg }, createReplacer());
      } catch (error) {
        line = JSON.stringify({ ts,
          level,
          msg,
          logError: errorText(error) });
      }
      write(line);
    } catch {
      // Logging must never take the service down.
    }
  };

  return {
    debug: (msg, fields) => {
      log('debug', msg, fields);
    },
    info: (msg, fields) => {
      log('info', msg, fields);
    },
    warn: (msg, fields) => {
      log('warn', msg, fields);
    },
    error: (msg, fields) => {
      log('error', msg, fields);
    },
  };
}
