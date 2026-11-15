import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStage } from '../../../src/engine/stages.js';
import { createMutableRedactor } from '../../../src/errors/redact.js';
import { createNewProjectContext } from '../../../src/scenarios/new-project/run.js';
import type { NewProjectDeps } from '../../../src/scenarios/new-project/run.js';
import { projectCreatedStage, tokenAcceptedStage } from '../../../src/scenarios/new-project/stages.js';
import { scenarioSecrets } from '../../../src/scenarios/send-and-receive/run.js';
import { createdProjects } from '../../../src/storage/created-projects.js';
import { pendingProjects } from '../../../src/storage/pending-projects.js';
import { openDatabase } from '../../../src/storage/database.js';
import { createHistory } from '../../../src/storage/history.js';
import { createFakeClock } from '../../support/fake-clock.js';
import type { FakeClock } from '../../support/fake-clock.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { createTestDeps } from '../../support/scenario.js';

const POLL_MS = 10_000;

let hawk: FakeHawk;
let clock: FakeClock;

beforeEach(async () => {
  hawk = await startFakeHawk();
  clock = createFakeClock();
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Builds dependencies on the fake clock; the collector of the new project is the real client of the test setup.
 * @returns Dependencies.
 */
function deps(): NewProjectDeps {
  const { deps: base } = createTestDeps(hawk, { clock,
    env: { SCENARIOS: 'new-project' } });
  const masking = createMutableRedactor(scenarioSecrets(base.config));
  const history = createHistory(openDatabase(':memory:'));

  return { ...base,
    redact: masking.redact,
    addSecret: masking.add,
    projects: createdProjects(history),
    pending: pendingProjects(history) };
}

/**
 * Waits until the collector has seen a number of POSTs.
 * @param count Expected number.
 */
async function postsReach(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(hawk.collector.posts).toBe(count);
  });
}

describe('tokenAcceptedStage on a fake clock', () => {
  it('sends again every ten seconds until the collector knows the token, and says how long that took', async () => {
    hawk.projects.knobs.tokenReloadMs = 600_000;

    const { context } = createNewProjectContext(deps(), { sequence: 1 });
    const runner = { clock,
      runSignal: new AbortController().signal };

    await runStage(projectCreatedStage(1000), context, runner);

    const running = runStage(tokenAcceptedStage(60_000), context, runner);

    await postsReach(1);
    // The collector reloads its tokens.
    const project = hawk.projects.get(context.created?.id ?? '');

    if (project) {
      project.activeAtMs = 0;
    }

    await clock.advance(POLL_MS - 1);
    expect(hawk.collector.posts).toBe(1);
    await clock.advance(1);

    const result = await running;

    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ attempts: 2,
      tokenAcceptedAfterMs: POLL_MS });
    expect(hawk.collector.posts).toBe(2);
  });

  it('gives up when the time of the stage is over, with new_token_not_accepted and the last word of the collector', async () => {
    hawk.projects.knobs.tokenReloadMs = 600_000;

    const { context } = createNewProjectContext(deps(), { sequence: 1 });
    const runner = { clock,
      runSignal: new AbortController().signal };

    await runStage(projectCreatedStage(1000), context, runner);

    const running = runStage(tokenAcceptedStage(60_000), context, runner);

    for (let sent = 1; sent <= 6; sent += 1) {
      await postsReach(sent);
      await clock.advance(POLL_MS);
    }

    const result = await running;

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'new_token_not_accepted',
      culprit: 'hawk' });
    expect(result.message).toContain('1m 0s');
    expect(result.message).toContain('Integration token invalid');
  });
});
