import { runStage } from '../../../src/engine/stages.js';
import { describe, expect, it, vi } from 'vitest';
import type { EventCard, HawkApi } from '../../../src/clients/hawk-api.js';
import type { StageResult } from '../../../src/engine/result.js';
import { createFakeClock } from '../../support/fake-clock.js';
import { TIMEOUT_LIMITS, createTestScenario } from '../../support/scenario.js';
import { CheckError } from '../../../src/errors/taxonomy.js';
import { groom } from '../../support/fake-hawk/grouper.js';
import { checkCard, eventMessage, sendEventShape } from '../../../src/scenarios/shared/event.js';
import { collectorAcceptStage, eventVisibleStage } from '../../../src/scenarios/shared/delivery.js';
import { cleanupStage } from '../../../src/scenarios/shared/cleanup.js';
import type { ScenarioContext } from '../../../src/scenarios/shared/context.js';
import { TIMEOUT_MS, run, scenario, useStageHarness } from '../../support/stage-harness.js';

const harness = useStageHarness();

const QUOTA_REFUSAL = JSON.stringify({ code: 402,
  error: true,
  message: 'Project has exceeded the events limit' });

describe('collectorAcceptStage', () => {
  it.each(['http', 'ws'] as const)('is ok over %s and the event reaches the store', async (transport) => {
    const { context, plan } = scenario({ transport });
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result.status).toBe('ok');
    expect(context.state.sendOutcome?.kind).toBe('accepted');
    expect(context.state.acceptedAtMs).toBeTypeOf('number');
    expect(context.state.sendMayHaveReached).toBe(false);
    expect(harness.hawk().store.all(harness.hawk().projectId)).toHaveLength(1);

    const [stored] = harness.hawk().store.all(harness.hawk().projectId);

    expect(stored?.catcherType).toBe(plan.catcherType);
    expect(stored?.payload).toEqual(groom(plan.catcherType, eventMessage(context).payload));
    expect(stored?.payload.title).toBe(plan.title);
    expect((stored?.payload.context as Record<string, unknown>).password).toBe('[filtered]');
  });

  it('calls beforeSend before the event reaches the collector', async () => {
    const { context } = scenario();
    let postsAtHook = -1;
    const result = await run(collectorAcceptStage(TIMEOUT_MS, () => {
      postsAtHook = harness.hawk().collector.posts;
    }), context);

    expect(result.status).toBe('ok');
    expect(postsAtHook).toBe(0);
    expect(harness.hawk().collector.posts).toBe(1);
  });

  it('payload carries three backtrace frames', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const [stored] = harness.hawk().store.all(harness.hawk().projectId);

    expect(stored?.payload.backtrace).toHaveLength(3);
    expect((stored?.payload.backtrace as Array<Record<string, unknown>>)[0]).toMatchObject({ file: 'hawk-e2e-monitor/check.js',
      function: 'check' });
  });

  it('fails with the class of a rejection and does not mark the send as reached', async () => {
    harness.hawk().collector.knobs.reply = () => ({ status: 402,
      body: QUOTA_REFUSAL });

    const { context } = scenario();
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'quota_exhausted',
      culprit: 'monitor' });
    expect(context.state.sendMayHaveReached).toBe(false);
  });

  it('is uncertain when the answer times out, and sends exactly once', async () => {
    harness.hawk().collector.knobs.replyDelayMs = 300;

    const { context } = scenario({ env: TIMEOUT_LIMITS });
    const before = context.clock.monotonicMs();
    const result = await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'uncertain',
      errorClass: 'collector_unavailable',
      culprit: 'hawk' });
    expect(context.state.sendMayHaveReached).toBe(true);
    expect(context.state.acceptedAtMs).toBeGreaterThanOrEqual(before);
    expect(context.state.acceptedAtMs).toBeLessThan(before + 50);
    expect(harness.hawk().collector.posts).toBe(1);
  });
});

describe('event shape', () => {
  it('collectorAcceptStage sends the message of the shape', async () => {
    const { context, plan } = scenario();
    const custom: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        message: base => ({ ...eventMessage(base),
          payload: { ...eventMessage(base).payload,
            title: `${plan.title} shaped` } }) } };

    await run(collectorAcceptStage(TIMEOUT_MS), custom);

    expect(harness.hawk().store.all(harness.hawk().projectId).map(event => event.payload.title)).toEqual([`${plan.title} shaped`]);
  });

  it('eventVisibleStage reads the project, matches and checks through the shape', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const elsewhere: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        projectId: 'c'.repeat(24) } };

    expect(await run(eventVisibleStage(TIMEOUT_MS), elsewhere)).toMatchObject({ status: 'failed',
      errorClass: 'api_forbidden' });

    const blind: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        matches: () => false } };

    // The search stops one HTTP timeout before the deadline, so the stage needs more than that.
    expect(await run(eventVisibleStage(1300), blind)).toMatchObject({ errorClass: 'event_not_found' });

    const strict: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        check: () => new CheckError('event_mismatch', { field: 'shape' }) } };

    expect(await run(eventVisibleStage(TIMEOUT_MS), strict)).toMatchObject({ errorClass: 'event_mismatch' });
  });

  it('cleanupStage asks the shape whether the event is ours', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);
    await run(eventVisibleStage(TIMEOUT_MS), context);

    const refusing: ScenarioContext = { ...context,
      eventShape: { ...sendEventShape(context),
        isOurs: () => false } };

    expect(await run(cleanupStage(TIMEOUT_MS), refusing)).toMatchObject({ status: 'failed',
      errorClass: 'cleanup_refused' });
    expect(harness.hawk().store.all(harness.hawk().projectId)).toHaveLength(1);
  });

  it('the default shape is the one of send-and-receive-event', () => {
    const { context, plan } = scenario();
    const shape = sendEventShape(context);

    expect(shape.projectId).toBe(context.config.hawk.projectId);
    expect(shape.message(context).payload).toMatchObject({ title: plan.title });
    expect(shape.matches({ originalEventId: 'e',
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      title: plan.title,
      context: {} })).toBe(true);
  });
});

const CARD_PATHS = [
  'type', 'release', 'user.id', 'user.name', 'get.e2e', 'addons.userAgent', 'addons.token', 'context.password', 'context.sequence',
  ...[0, 1].flatMap(index => ['timestamp', 'type', 'category', 'message', 'level'].map(key => `breadcrumbs[${String(index)}].${key}`)),
  ...[0, 1, 2].flatMap(index => ['file', 'line', 'column', 'function', 'arguments', 'sourceCode'].map(key => `backtrace[${String(index)}].${key}`)),
];

/**
 * Removes the value at a path such as `backtrace[1].line`.
 * @param payload Payload to change.
 * @param path Dotted path with indexes in brackets.
 * @returns The same payload without the value.
 */
function deleteAt(payload: Record<string, unknown>, path: string): Record<string, unknown> {
  const steps = path.split(/[.[\]]+/u).filter(step => step !== '');
  const last = steps.pop() ?? '';
  let target: unknown = payload;

  for (const step of steps) {
    target = (target as Record<string, unknown>)[step];
  }

  Reflect.deleteProperty(target as Record<string, unknown>, last);

  return payload;
}

describe('the fields of the card', () => {
  it.each(CARD_PATHS)('a lost %s fails the event as event_mismatch naming the field', async (path) => {
    const { context } = scenario();

    harness.hawk().collector.knobs.mutatePayload = payload => deleteAt(payload, path);

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_mismatch',
      culprit: 'hawk' });
    expect(result.message).toContain(path);
  });

  it('passes when every field arrives', async () => {
    const { context } = scenario();

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    expect((await run(eventVisibleStage(TIMEOUT_MS), context)).status).toBe('ok');
  });

  it('fails with field_not_masked when the password and the token arrive as sent', async () => {
    const { context } = scenario();

    harness.hawk().store.knobs.unmasked = true;
    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'field_not_masked',
      culprit: 'hawk' });
    expect(result.message).toContain('context.password');
  });

  it('fails an errors/nodejs event that carries beautifiedUserAgent', async () => {
    const { context } = scenario({ transport: 'http' });

    harness.hawk().collector.knobs.mutatePayload = (payload) => {
      (payload.addons as Record<string, unknown>).beautifiedUserAgent = { os: 'Linux' };

      return payload;
    };
    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_mismatch' });
    expect(result.message).toContain('unexpected field beautifiedUserAgent');
  });

  it('accepts the beautifiedUserAgent that the JavaScript worker adds, and its absence', async () => {
    const withWorker = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), withWorker.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), withWorker.context)).status).toBe('ok');
    expect(harness.hawk().store.all(harness.hawk().projectId)[0]?.payload.addons).toHaveProperty('beautifiedUserAgent');

    // The second run has the same run id, so the first event must go.
    harness.hawk().store.remove(harness.hawk().projectId, harness.hawk().store.all(harness.hawk().projectId)[0]?.id ?? '');

    harness.hawk().store.knobs.noJsWorker = true;

    const without = scenario({ transport: 'ws',
      sequence: 2 });

    await run(collectorAcceptStage(TIMEOUT_MS), without.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), without.context)).status).toBe('ok');
  });

  it('marks a JavaScript event without the JavaScript worker as degraded, not failed', async () => {
    harness.hawk().store.knobs.noJsWorker = true;

    const { context } = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), context);

    const result = await run(eventVisibleStage(TIMEOUT_MS), context);

    expect(result.status).toBe('ok');
    expect(result.details?.degraded).toEqual(['js_worker_not_seen']);
    expect(result.details?.warning).toContain('beautifiedUserAgent');
  });

  it('has no degradation when the JavaScript worker answered or the event is not JavaScript', async () => {
    const withWorker = scenario({ transport: 'ws' });

    await run(collectorAcceptStage(TIMEOUT_MS), withWorker.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), withWorker.context)).details?.degraded).toBeUndefined();

    harness.hawk().store.remove(harness.hawk().projectId, harness.hawk().store.all(harness.hawk().projectId)[0]?.id ?? '');

    const node = scenario({ transport: 'http' });

    await run(collectorAcceptStage(TIMEOUT_MS), node.context);
    expect((await run(eventVisibleStage(TIMEOUT_MS), node.context)).details?.degraded).toBeUndefined();
  });

  describe('the shape of beautifiedUserAgent on a JavaScript event', () => {
    /**
     * Builds the card of a JavaScript event with a given value of the field.
     * @param value Value of `addons.beautifiedUserAgent`; the key is left out when undefined.
     * @returns The error of the check and nothing else.
     */
    function checked(value: unknown): CheckError | undefined {
      const { context, plan } = scenario({ transport: 'ws' });
      const sent = eventMessage(context).payload;
      const groomed = groom(plan.catcherType, sent);
      const addons = { ...groomed.addons as Record<string, unknown> };

      if (value === undefined) {
        delete addons.beautifiedUserAgent;
      } else {
        addons.beautifiedUserAgent = value;
      }

      return checkCard({ originalEventId: 'e',
        groupHash: 'g',
        totalCount: 1,
        catcherType: plan.catcherType,
        title: plan.title,
        ...groomed,
        addons,
        usersAffected: 1 } as EventCard, sent, plan, 1);
    }

    it('accepts an object with the four string fields, extra fields included, and an absent value', () => {
      expect(checked({ os: 'Linux',
        osVersion: '6',
        browser: 'Chrome',
        browserVersion: '120',
        extra: 1 })).toBeUndefined();
      expect(checked(undefined)).toBeUndefined();
    });

    it.each([
      ['null', null],
      ['an empty object', {}],
      ['an object without osVersion', { os: 'Linux',
        browser: 'Chrome',
        browserVersion: '120' }],
      ['a field that is not a string', { os: 'Linux',
        osVersion: 6,
        browser: 'Chrome',
        browserVersion: '120' }],
      ['an array', []],
      ['a string', 'Linux'],
    ])('rejects %s as event_mismatch of addons.beautifiedUserAgent', (_label, value) => {
      expect(checked(value)).toMatchObject({ errorClass: 'event_mismatch',
        facts: { field: 'addons.beautifiedUserAgent' } });
    });
  });

  it('checks that one user was affected', () => {
    const { context, plan } = scenario();
    const sent = eventMessage(context).payload;
    const card = (usersAffected: number | undefined): EventCard => ({ originalEventId: 'e',
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      title: plan.title,
      ...groom(plan.catcherType, sent),
      ...usersAffected === undefined ? {} : { usersAffected } } as EventCard);

    expect(checkCard(card(1), sent, plan, 1)).toBeUndefined();
    expect(checkCard(card(2), sent, plan, 1)).toMatchObject({ errorClass: 'event_mismatch',
      facts: { field: 'usersAffected',
        expected: '1',
        actual: '2' } });
    expect(checkCard(card(undefined), sent, plan, 1)).toMatchObject({ errorClass: 'event_mismatch' });
  });
});

describe('eventVisibleStage on a fake clock', () => {
  const STAGE_MS = 10_000;
  const HTTP_MS = 2000;

  /** What a run on the fake clock leaves. */
  interface FakeRun {
    /** Recorded stage result. */
    result: StageResult;
    /** Context the stage ran in. */
    context: ScenarioContext;
  }

  /**
   * Runs the stage with an API whose answers take fake time.
   * @param appearsAtMs When the search starts to find the event.
   * @param cardMs How long the card read takes.
   * @returns The result and the context.
   */
  async function runOnFakeClock(appearsAtMs: number, cardMs: number): Promise<FakeRun> {
    const clock = createFakeClock();
    const { context, plan } = createTestScenario(harness.hawk());
    const found = { originalEventId: 'e'.repeat(24),
      groupHash: 'g',
      totalCount: 1,
      catcherType: plan.catcherType,
      ...groom(plan.catcherType, eventMessage(context).payload),
      usersAffected: 1 } as EventCard;
    const api: HawkApi = { ...context.api,
      findEvents: () => Promise.resolve(clock.monotonicMs() >= appearsAtMs ? [found] : []),
      eventCard: async (_projectId, _eventId, signal) => {
        await clock.sleep(cardMs, signal);

        return found;
      } };
    const fake: ScenarioContext = { ...context,
      api,
      clock,
      pollScheduleMs: [500],
      config: { ...context.config,
        httpTimeoutMs: HTTP_MS } };
    const running = runStage(eventVisibleStage(STAGE_MS), fake, { clock,
      runSignal: new AbortController().signal });

    // Small steps, so a sleep that a loaded machine registers late is still reached.
    for (let elapsed = 0; elapsed < STAGE_MS + 2000; elapsed += 100) {
      await clock.advance(100);
    }

    return { result: await running,
      context: fake };
  }

  it('an event found at the end of the search gets its card read before the deadline', async () => {
    // Without jitter the probes fall on 0, 500, ... 7500, so one of them sees the event before the search ends at 8000.
    // With the default jitter a probe gap of up to 600 ms can step over the end of the search.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const { result } = await runOnFakeClock(7500, HTTP_MS - 1);

    expect(result.status).toBe('ok');
  });

  it('the search stops HTTP_TIMEOUT_MS before the deadline', async () => {
    const { result } = await runOnFakeClock(Number.POSITIVE_INFINITY, 0);
    const waitedMs = Number(result.details?.waitedMs);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_not_found' });
    expect(waitedMs).toBeGreaterThanOrEqual(7000);
    expect(waitedMs).toBeLessThan(9000);
  });

  it('an event that appears inside the last HTTP timeout is not found, and no card is read', async () => {
    const { result, context } = await runOnFakeClock(STAGE_MS - 1000, 0);

    expect(result).toMatchObject({ status: 'failed',
      errorClass: 'event_not_found' });
    expect(context.state.event).toBeUndefined();
  });
});
