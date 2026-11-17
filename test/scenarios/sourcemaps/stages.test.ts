import { describe, expect, it } from 'vitest';
import type { EventCard } from '../../../src/clients/hawk-api.js';
import { planRun } from '../../../src/scenarios/shared/plan.js';
import { buildSourceMap, expectedSourceCode } from '../../../src/scenarios/sourcemaps/map.js';
import { checkSourcemapCard } from '../../../src/scenarios/sourcemaps/stages.js';
import { testConfig } from '../../support/config.js';

const config = testConfig({ instanceId: 'mon' });
const plan = planRun(config, { sequence: 1,
  transport: 'http',
  catcherType: 'errors/javascript' }, 'sourcemaps', count => 'a'.repeat(count));
const built = buildSourceMap(plan.runId);
const RELEASE = `e2e-mon-${plan.runId}`;

/**
 * Builds the card of a mapped event, with changes.
 * @param changes Fields of the good card to replace.
 * @returns A card in which the map was applied, but for the changes.
 */
function card(changes: Partial<EventCard> = {}): EventCard {
  return { originalEventId: 'e',
    groupHash: 'g',
    totalCount: 1,
    catcherType: 'errors/javascript',
    title: plan.title,
    context: plan.context,
    release: RELEASE,
    backtrace: [{ file: 'e2e-source.js',
      line: 6,
      column: 0,
      sourceCode: expectedSourceCode(built.sourceLines, 6) }],
    ...changes };
}

describe('checkSourcemapCard', () => {
  it('accepts an event at the original file with the lines around it', () => {
    expect(checkSourcemapCard(card(), built, RELEASE, plan, 1)).toBeUndefined();
  });

  it('names the file when the frame stayed at the minified one', () => {
    const error = checkSourcemapCard(card({ backtrace: [{ file: `https://e2e.invalid/${built.fileName}`,
      line: 1,
      column: 0 }] }), built, RELEASE, plan, 1);

    expect(error).toMatchObject({ errorClass: 'sourcemap_not_applied',
      culprit: 'hawk',
      facts: { field: 'backtrace[0].file',
        expected: 'e2e-source.js' } });
  });

  it('names the source code when the file is right and the lines are not', () => {
    const error = checkSourcemapCard(card({ backtrace: [{ file: 'e2e-source.js',
      line: 6,
      column: 0,
      sourceCode: [{ line: 6,
        content: 'other' }] }] }), built, RELEASE, plan, 1);

    expect(error).toMatchObject({ errorClass: 'sourcemap_not_applied',
      facts: { field: 'backtrace[0].sourceCode' } });
  });

  it('treats a card without a backtrace as a map that was not applied', () => {
    expect(checkSourcemapCard(card({ backtrace: undefined }), built, RELEASE, plan, 1)).toMatchObject({ errorClass: 'sourcemap_not_applied' });
  });

  it('checks the title, the context and the count before the map', () => {
    expect(checkSourcemapCard(card({ title: 'other' }), built, RELEASE, plan, 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'title' } });
    expect(checkSourcemapCard(card({ totalCount: 2 }), built, RELEASE, plan, 1)).toMatchObject({ errorClass: 'duplicate_event' });
  });

  it('checks the release of the card', () => {
    expect(checkSourcemapCard(card({ release: 'e2e-mon-plain' }), built, RELEASE, plan, 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'release' } });
  });
});
