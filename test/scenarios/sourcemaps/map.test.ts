import { Script } from 'node:vm';
import { SourceMapConsumer } from 'source-map-js';
import { describe, expect, it } from 'vitest';
import type { SourceCodeLine, SourceMapV3 } from '../../../src/scenarios/sourcemaps/map.js';
import { buildSourceMap, expectedSourceCode } from '../../../src/scenarios/sourcemaps/map.js';

const RUN_ID = 'rabcdefghijklmno';
const MARGIN = 5;

/**
 * Decodes a map with the decoder of Hawk; its types ask for a version as text, the code takes both.
 * @param map Map that the minimal build made.
 * @returns Decoder.
 */
function decode(map: SourceMapV3): SourceMapConsumer {
  return new SourceMapConsumer({ ...map,
    version: String(map.version) });
}

/**
 * Reads the lines around a position the way the JavaScript worker of Hawk does, from the source the map carries.
 * @param consumer Decoder of the map.
 * @param source Name of the source file.
 * @param line Line of the original position.
 * @returns Lines with their numbers.
 */
function hawkLines(consumer: SourceMapConsumer, source: string, line: number): SourceCodeLine[] {
  const content = consumer.sourceContentFor(source, true) ?? '';
  const lines = content.split(/(?:\r\n|\r|\n)/gu);

  return lines.slice(line - MARGIN - 1, line + MARGIN).map((text, index) => ({ line: Math.max(line - MARGIN + index, 1),
    content: text }));
}

describe('buildSourceMap', () => {
  const built = buildSourceMap(RUN_ID);

  it('names the file after the run and keeps the minified file on one line', () => {
    expect(built.fileName).toBe(`e2e-${RUN_ID}.min.js`);
    expect(built.minified).not.toContain('\n');
    expect(built.minified.length).toBeGreaterThan(0);
  });

  it('is a version 3 map of one source without a path, with the source inside', () => {
    expect(built.map).toMatchObject({ version: 3,
      sources: ['e2e-source.js'],
      names: [] });
    expect(built.map).not.toHaveProperty('sourceRoot');
    expect(built.map.sourcesContent).toEqual([built.sourceLines.join('\n')]);
  });

  it('has eleven lines of valid JavaScript in the source and in the minified file', () => {
    expect(built.sourceLines).toHaveLength(11);
    expect(() => new Script(built.sourceLines.join('\n'))).not.toThrow();
    expect(() => new Script(built.minified)).not.toThrow();
  });

  it('differs between runs, so that no cache of Hawk can serve an old answer', () => {
    expect(buildSourceMap('rzzzzzzzzzzzzzzz').minified).not.toBe(built.minified);
    expect(buildSourceMap('rzzzzzzzzzzzzzzz').fileName).not.toBe(built.fileName);
  });

  it('decodes with source-map-js, the decoder of Hawk, from line 1 column 0 to line 6 column 0', () => {
    const consumer = decode(built.map);
    const position = consumer.originalPositionFor({ line: 1,
      column: 0,
      bias: SourceMapConsumer.LEAST_UPPER_BOUND });

    expect(position).toMatchObject({ source: 'e2e-source.js',
      line: 6,
      column: 0 });
  });

  it('puts a real statement on line 6 of the source', () => {
    expect(built.sourceLines[5]?.trim().length).toBeGreaterThan(1);
  });
});

describe('expectedSourceCode', () => {
  const built = buildSourceMap(RUN_ID);
  const consumer = decode(built.map);

  it('is every line of the source around line 6, numbered from 1', () => {
    const expected = expectedSourceCode(built.sourceLines, 6);

    expect(expected).toHaveLength(11);
    expect(expected[0]).toEqual({ line: 1,
      content: built.sourceLines[0] });
    expect(expected.at(-1)).toEqual({ line: 11,
      content: built.sourceLines[10] });
  });

  it.each([3, 6, 7, 11])('matches the slice the worker of Hawk makes at line %i', (line) => {
    expect(expectedSourceCode(built.sourceLines, line)).toEqual(hawkLines(consumer, 'e2e-source.js', line));
  });
});
