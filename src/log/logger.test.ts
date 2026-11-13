import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import type { LoggerOptions } from './logger.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const CAUSE_LIMIT = 5;

/** Logger under test with its captured output. */
interface Harness {
  /** Raw lines passed to `write`. */
  lines: string[];
  /** Logger writing into `lines`. */
  logger: ReturnType<typeof createLogger>;
}

/**
 * Builds a logger that captures lines and uses a fixed clock.
 * @param options Overrides for the logger options.
 * @returns Logger and the captured lines.
 */
function harness(options: Partial<LoggerOptions> = {}): Harness {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    now: () => NOW,
    write: (line) => {
      lines.push(line);
    },
    ...options,
  });

  return { lines,
    logger };
}

/**
 * Parses the only captured line.
 * @param lines Captured lines.
 * @returns Parsed JSON object.
 */
function parseOnly(lines: readonly string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);

  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('createLogger', () => {
  it('filters below level', () => {
    const { lines, logger } = harness({ level: 'warn' });

    logger.debug('d');
    logger.info('i');
    expect(lines).toHaveLength(0);
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(2);
  });

  it('writes ts, level, msg and fields', () => {
    const { lines, logger } = harness();

    logger.info('hello', { runId: 'r1' });

    expect(parseOnly(lines)).toEqual({
      runId: 'r1',
      ts: NOW.toISOString(),
      level: 'info',
      msg: 'hello',
    });
  });

  it('reserved keys win over fields', () => {
    const { lines, logger } = harness();

    logger.info('hello', { level: 'x',
      msg: 'y',
      ts: 'z' });

    expect(parseOnly(lines)).toMatchObject({ level: 'info',
      msg: 'hello',
      ts: NOW.toISOString() });
  });

  it('serializes error with code and cause chain', () => {
    const { lines, logger } = harness();
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    logger.error('failed', { error: new Error('fetch failed', { cause }) });

    const error = parseOnly(lines).error as Record<string, unknown>;
    const inner = error.cause as Record<string, unknown>;

    expect(error).toMatchObject({ name: 'Error',
      message: 'fetch failed' });
    expect(error).not.toHaveProperty('code');
    expect(typeof error.stack).toBe('string');
    expect(inner.code).toBe('ECONNREFUSED');
    expect(typeof inner.stack).toBe('string');
  });

  it('limits cause depth', () => {
    const { lines, logger } = harness();
    const chain = Array.from({ length: 7 }, (_, index) => `e${String(index)}`).reduceRight<Error | undefined>(
      (cause, name) => new Error(name, { cause }),
      undefined
    );

    logger.error('deep', { error: chain });

    let node: unknown = parseOnly(lines).error;

    for (let level = 0; level < CAUSE_LIMIT; level += 1) {
      node = (node as Record<string, unknown>).cause;
    }
    expect(node).toBe('[cause depth exceeded]');
  });

  it('keeps a non-Error cause as is', () => {
    const { lines, logger } = harness();

    logger.error('odd', { error: new Error('outer', { cause: 'plain text' }) });

    expect((parseOnly(lines).error as Record<string, unknown>).cause).toBe('plain text');
  });

  it('survives circular objects', () => {
    const { lines, logger } = harness();
    const loop: Record<string, unknown> = { name: 'loop' };

    loop.self = loop;
    logger.info('circular', { loop });

    expect(parseOnly(lines).loop).toEqual({ name: 'loop',
      self: '[Circular]' });
  });

  it('shared reference is not circular', () => {
    const { lines, logger } = harness();
    const shared = { value: 1 };

    logger.info('shared', { first: shared,
      second: shared });

    const line = parseOnly(lines);

    expect(line.first).toEqual({ value: 1 });
    expect(line.second).toEqual({ value: 1 });
  });

  it('survives bigint', () => {
    const { lines, logger } = harness();

    logger.info('big', { n: 10n });

    expect(parseOnly(lines).n).toBe('10');
  });

  it('falls back when serialization fails', () => {
    const { lines, logger } = harness();
    const bad = {
      toJSON(): never {
        throw new Error('cannot serialize');
      },
    };

    expect(() => {
      logger.info('broken', { bad });
    }).not.toThrow();
    expect(parseOnly(lines)).toEqual({
      ts: NOW.toISOString(),
      level: 'info',
      msg: 'broken',
      logError: 'cannot serialize',
    });
  });

  it('survives throwing write', () => {
    const { logger } = harness({
      write: () => {
        throw new Error('disk full');
      },
    });

    expect(() => {
      logger.info('x');
    }).not.toThrow();
  });
});
