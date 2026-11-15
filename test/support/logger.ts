import type { LogFields, Logger } from '../../src/log/logger.js';

/** Logger that keeps every call in memory for assertions. */
export interface MemoryLogger extends Logger {
  /** Recorded calls as flat `{ level, msg, ...fields }` entries. */
  lines: Array<Record<string, unknown>>;
}

/**
 * Creates a logger that records calls instead of printing them.
 * @returns Logger with its recorded entries; no level filtering.
 */
export function memoryLogger(): MemoryLogger {
  const lines: Array<Record<string, unknown>> = [];
  const record = (level: string) => (msg: string, fields?: LogFields): void => {
    lines.push({ level,
      msg,
      ...fields });
  };

  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}
