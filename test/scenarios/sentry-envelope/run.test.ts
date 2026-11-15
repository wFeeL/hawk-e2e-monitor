import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult, StageName, StageResult } from '../../../src/engine/result.js';
import { decodeIntegrationToken, tokenKey } from '../../../src/hawk/token.js';
import { outcomeOf } from '../../../src/storage/outcome.js';
import { runSentryEnvelope } from '../../../src/scenarios/sentry-envelope/run.js';
import { startFakeHawk } from '../../support/fake-hawk/index.js';
import type { FakeHawk } from '../../support/fake-hawk/index.js';
import { createTestDeps } from '../../support/scenario.js';
import type { TestDepsOptions } from '../../support/scenario.js';

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Runs the scenario on the fake Hawk.
 * @param options Environment and clock overrides.
 * @returns Result of the run.
 */
async function run(options: TestDepsOptions = {}): Promise<RunResult> {
  const { deps } = createTestDeps(hawk, { ...options,
    env: { SCENARIOS: 'sentry-envelope',
      ...options.env } });

  return runSentryEnvelope(deps, { sequence: 1 });
}

/**
 * Finds a stage of a result.
 * @param result Result of a run.
 * @param name Stage to look for.
 * @returns The recorded stage.
 */
function stageOf(result: RunResult, name: StageName): StageResult {
  const found = result.stages.find(item => item.name === name);

  if (found === undefined) {
    throw new Error(`no stage ${name}`);
  }

  return found;
}

describe('a healthy run', () => {
  it('posts the envelope, finds the event that came through the Sentry path and removes it', async () => {
    const result = await run();

    expect(result).toMatchObject({ status: 'ok',
      scenario: 'sentry-envelope',
      catcherType: 'errors/default' });
    expect(result.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['collector_availability', 'ok'],
      ['api_availability', 'ok'],
      ['collector_accept', 'ok'],
      ['event_visible', 'ok'],
      ['cleanup', 'ok'],
    ]);
    expect(result.title).toBe(`[e2e:fake] ${result.runId} sentry-envelope`);
    expect(hawk.collector.envelopePosts).toBe(1);
    expect(hawk.collector.posts).toBe(0);
    expect(hawk.store.all(hawk.projectId)).toHaveLength(0);
  });

  it('shows Hawk the event with the title of type and value, and keeps the key out of the result', async () => {
    let seen = '';

    hawk.store.subscribe((_project, event) => {
      seen = String(event.payload.title);
    });

    const result = await run();
    const key = tokenKey(decodeIntegrationToken(hawk.token) ?? { integrationId: '',
      secret: '' });

    expect(seen).toBe(`E2eMonitorCheck: [e2e:fake] ${result.runId} sentry-envelope`);
    expect(JSON.stringify(result)).not.toContain(key);
  });
});

describe('failures', () => {
  it('an envelope the collector did not confirm, though the event arrived, is an ok run with a warning and accept_uncertain', async () => {
    hawk.collector.knobs.replyDelayMs = 400;

    const result = await run({ env: { HTTP_TIMEOUT_MS: '300',
      COLLECTOR_ACCEPT_TIMEOUT_MS: '2000' } });

    expect(result.status).toBe('ok');
    expect(result.warnings.join(' ')).toContain('did not confirm the envelope');
    expect(outcomeOf(result, { loopEnabled: false }).degraded).toEqual(['accept_uncertain']);
  });

  it('a refused envelope is sentry_rejected', async () => {
    hawk.collector.knobs.envelopeReply = { status: 400,
      body: '{"code":400,"error":true,"message":"Failed to process Sentry envelope"}' };

    const result = await run();

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_accept',
      errorClass: 'sentry_rejected',
      culprit: 'hawk' });
    expect(stageOf(result, 'event_visible').status).toBe('skipped');
    expect(stageOf(result, 'cleanup').status).toBe('skipped');
  });

  it('an envelope that is answered 200 and never shows as an event is event_not_found', async () => {
    hawk.collector.knobs.dropEvents = true;

    const result = await run({ env: { HTTP_TIMEOUT_MS: '100',
      EVENT_VISIBLE_TIMEOUT_MS: '400' } });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_not_found' });
  });

  it('an event that came with another catcher type is a mismatch', async () => {
    hawk.collector.knobs.mutatePayload = payload => payload;

    const { deps } = createTestDeps(hawk, { env: { SCENARIOS: 'sentry-envelope' } });
    const result = await runSentryEnvelope({ ...deps,
      collector: { ...deps.collector,
        sendEnvelope: async (key, body, signal) => deps.collector.sendEnvelope(key, body.replace('sentry.python', 'sentry.javascript.browser'), signal) } }, { sequence: 1 });

    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'event_visible',
      errorClass: 'event_mismatch' });
    expect(result.message).toContain('catcherType');
  });

  it('a collector that is down stops the run at the first stage', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const result = await run();

    expect(result).toMatchObject({ failedStage: 'collector_availability' });
    expect(hawk.collector.envelopePosts).toBe(0);
  });

  it('an uncertain send is followed by the search, and the event is found and removed', async () => {
    hawk.collector.knobs.replyDelayMs = 400;

    const result = await run({ env: { HTTP_TIMEOUT_MS: '300',
      COLLECTOR_ACCEPT_TIMEOUT_MS: '2000' } });

    expect(stageOf(result, 'collector_accept').status).toBe('uncertain');
    expect(stageOf(result, 'event_visible').status).toBe('ok');
    expect(stageOf(result, 'cleanup').status).toBe('ok');
  });
});
