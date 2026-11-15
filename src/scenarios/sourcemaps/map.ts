const SOURCE_NAME = 'e2e-source.js';
// One segment: line 1 column 0 of the minified file to line 6 column 0 of the source (generated column 0, source 0, line +5, column 0).
const MAPPINGS = 'AAKA';
const MARGIN = 5;
const SOURCE_MAP_VERSION = 3;

/** A source map of version 3. */
export interface SourceMapV3 {
  /** Format version. */
  version: number;
  /** Name of the minified file. */
  file: string;
  /** Names of the original files, with no path. */
  sources: string[];
  /** Text of each original file. */
  sourcesContent: string[];
  /** Names of identifiers; none here. */
  names: string[];
  /** Encoded segments. */
  mappings: string;
}

/** A minimal source map with the files it describes. */
export interface BuiltSourceMap {
  /** One-line minified file the event points at. */
  minified: string;
  /** Source map version 3 that sends line 1 column 0 of the minified file to line 6 column 0 of the source. */
  map: SourceMapV3;
  /** Name of the minified file, which the release uses to find the map. */
  fileName: string;
  /** Lines of the original source. */
  sourceLines: string[];
}

/** One line of source code as the card shows it. */
export interface SourceCodeLine {
  /** Number of the line, from 1. */
  line: number;
  /** Text of the line. */
  content: string;
}

/**
 * Builds a source map the JavaScript worker of Hawk can apply, unique to a run.
 * The source is valid JavaScript, because the worker parses it to name the function; the map carries the source itself.
 * @param runId Id of the run, which keeps the file and the content apart from other runs.
 * @returns Minified file, map, file name and the source lines.
 */
export function buildSourceMap(runId: string): BuiltSourceMap {
  const fileName = `e2e-${runId}.min.js`;
  const sourceLines = [
    '\'use strict\';',
    '',
    'function checkRun(input) {',
    '  const label = \'e2e-monitor\';',
    '  const value = input + 1;',
    '  return `${label}:${String(value)}`;',
    '}',
    '',
    'module.exports = checkRun;',
    `// run ${runId}`,
    '// end of the source',
  ];

  return { minified: `function a(b){return "e2e-monitor:"+(b+1)}module.exports=a;//# sourceMappingURL=${fileName}.map`,
    map: { version: SOURCE_MAP_VERSION,
      file: fileName,
      sources: [SOURCE_NAME],
      sourcesContent: [sourceLines.join('\n')],
      names: [],
      mappings: MAPPINGS },
    fileName,
    sourceLines };
}

/**
 * Computes the source lines Hawk puts into the frame it maps: five above and five below, the way the worker slices them.
 * Near the top of the file the start index goes negative and counts from the end, as in the worker.
 * @param sourceLines All lines of the original source file.
 * @param line Line of the original position, the one the map sends the frame to.
 * @returns Lines with their numbers, none below 1.
 */
export function expectedSourceCode(sourceLines: readonly string[], line: number): SourceCodeLine[] {
  return sourceLines.slice(line - MARGIN - 1, line + MARGIN).map((content, index) => ({ line: Math.max(line - MARGIN + index, 1),
    content }));
}
