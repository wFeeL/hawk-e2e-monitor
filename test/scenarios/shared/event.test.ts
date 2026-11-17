import { describe, expect, it } from 'vitest';
import type { FoundEvent } from '../../../src/clients/hawk-api.js';
import { testConfig } from '../../support/config.js';
import { planRun } from '../../../src/scenarios/shared/plan.js';
import { BROWSER_USER_AGENT, EVENT_LIMITS, checkEventFields, eventMessage, isOurEvent, withinEventLimits } from '../../../src/scenarios/shared/event.js';
import { scenario, useStageHarness } from '../../support/stage-harness.js';

useStageHarness();

describe('checkEventFields', () => {
  const plan = planRun(testConfig(), { sequence: 1 }, 'send-and-receive-event');
  const good: FoundEvent = { originalEventId: 'e1',
    groupHash: 'g',
    totalCount: 1,
    catcherType: plan.catcherType,
    title: plan.title,
    context: { runId: plan.runId,
      instanceId: plan.context.instanceId } };

  it('accepts the event we sent', () => {
    expect(checkEventFields(good, plan, 1)).toBeUndefined();
  });

  it.each([
    ['title', { title: 'other' }],
    ['context.runId', { context: { runId: 'x',
      instanceId: plan.context.instanceId } }],
    ['context.instanceId', { context: { runId: plan.runId,
      instanceId: 'x' } }],
    ['catcherType', { catcherType: 'errors/default' }],
  ] as const)('event_mismatch on %s', (field, change) => {
    const error = checkEventFields({ ...good,
      ...change }, plan, 1);

    expect(error?.errorClass).toBe('event_mismatch');
    expect(error?.facts.field).toBe(field);
  });

  it('reports the first differing field in the documented order', () => {
    const error = checkEventFields({ ...good,
      title: 'other',
      catcherType: 'errors/default' }, plan, 1);

    expect(error?.facts.field).toBe('title');
  });

  it('event_mismatch when the context is missing', () => {
    expect(checkEventFields({ ...good,
      context: null }, plan, 1)?.facts.field).toBe('context.runId');
  });

  it('duplicate_event when totalCount is above the expected count', () => {
    const error = checkEventFields({ ...good,
      totalCount: 3 }, plan, 2);

    expect(error?.errorClass).toBe('duplicate_event');
    expect(error?.facts.count).toBe(3);
  });

  it('event_mismatch when totalCount is below the expected count', () => {
    const error = checkEventFields({ ...good,
      totalCount: 0 }, plan, 1);

    expect(error?.errorClass).toBe('event_mismatch');
    expect(error?.facts.field).toBe('totalCount');
  });
});

describe('isOurEvent', () => {
  const plan = planRun(testConfig(), { sequence: 1 }, 'send-and-receive-event');
  const base: FoundEvent = { originalEventId: 'e1',
    groupHash: 'g',
    totalCount: 1,
    catcherType: plan.catcherType,
    title: 'unrelated',
    context: {} };

  it('recognizes the title prefix', () => {
    expect(isOurEvent({ ...base,
      title: plan.title }, plan, plan.context.instanceId)).toBe(true);
  });

  it('recognizes our context when the title is mangled', () => {
    expect(isOurEvent({ ...base,
      context: { runId: plan.runId,
        instanceId: plan.context.instanceId } }, plan, plan.context.instanceId)).toBe(true);
  });

  it('refuses a title of another run or instance', () => {
    expect(isOurEvent({ ...base,
      title: `[e2e:${plan.context.instanceId}] rother send-and-receive-event` }, plan, plan.context.instanceId)).toBe(false);
    expect(isOurEvent({ ...base,
      title: `[e2e:other] ${plan.runId} send-and-receive-event` }, plan, plan.context.instanceId)).toBe(false);
  });

  it('refuses a context with only the run id', () => {
    expect(isOurEvent({ ...base,
      context: { runId: plan.runId } }, plan, plan.context.instanceId)).toBe(false);
  });

  it('refuses a foreign event with an empty context', () => {
    expect(isOurEvent({ ...base,
      title: `foreign ${plan.runId}` }, plan, plan.context.instanceId)).toBe(false);
  });
});

const PAN_PATTERN = /^(?:4[0-9]{12}(?:[0-9]{3})?|[25][1-7][0-9]{14}|6(?:011|5[0-9][0-9])[0-9]{12}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|(?:2131|1800|35\d{3})\d{11})$/u;
const OBJECT_ID = /^[0-9a-f]{24}$/iu;
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/iu;

/**
 * Applies the card number test the Hawk grouper runs on the values of `context` and `addons`.
 * @param value Any value of the event.
 * @returns True when the grouper would replace a string with `[filtered]`.
 */
function looksLikeCardNumber(value: unknown): boolean {
  if (typeof value === 'string') {
    return !OBJECT_ID.test(value) && !UUID.test(value) && PAN_PATTERN.test(value.replaceAll(/\D/gu, ''));
  }

  if (Array.isArray(value)) {
    return value.some(looksLikeCardNumber);
  }

  return typeof value === 'object' && value !== null && Object.values(value).some(looksLikeCardNumber);
}

describe('eventMessage', () => {
  it.each(['http', 'ws'] as const)('carries the fields of the card over %s', (transport) => {
    const { context, plan } = scenario({ transport });
    const { payload, catcherType } = eventMessage(context);
    const instanceId = plan.context.instanceId;

    expect(catcherType).toBe(plan.catcherType);
    expect(payload).toMatchObject({ title: plan.title,
      type: 'E2eMonitorCheck',
      release: `e2e-${instanceId}-plain`,
      user: { id: `e2e-${instanceId}`,
        name: 'e2e monitor' },
      get: { e2e: plan.runId },
      addons: { userAgent: BROWSER_USER_AGENT,
        token: 'e2e-sentinel' },
      context: { ...plan.context,
        password: 'e2e-sentinel' } });

    const frames = payload.backtrace as Array<Record<string, unknown>>;

    expect(frames).toHaveLength(3);

    for (const frame of frames) {
      expect(frame).toMatchObject({ file: expect.any(String) as string,
        line: expect.any(Number) as number,
        column: expect.any(Number) as number,
        function: expect.any(String) as string,
        arguments: expect.any(Array) as unknown[] });
      expect(frame.sourceCode).toHaveLength(3);
      expect((frame.sourceCode as Array<Record<string, unknown>>)[0]).toMatchObject({ line: expect.any(Number) as number,
        content: expect.any(String) as string });
    }

    const crumbs = payload.breadcrumbs as Array<Record<string, unknown>>;

    expect(crumbs).toHaveLength(2);

    for (const crumb of crumbs) {
      expect(crumb).toMatchObject({ timestamp: expect.any(Number) as number,
        type: expect.any(String) as string,
        category: expect.any(String) as string,
        message: expect.any(String) as string,
        level: expect.any(String) as string });
      // Hawk reads breadcrumb times as milliseconds.
      expect(crumb.timestamp).toBeGreaterThan(1e12);
    }
  });

  it('is the same message every time, so a repeat matches the first event', () => {
    const { context } = scenario();

    expect(eventMessage(context)).toEqual(eventMessage(context));
  });

  it.each(['http', 'ws'] as const)('stays within what the grouper keeps over %s', (transport) => {
    const { payload } = eventMessage(scenario({ transport }).context);

    expect(withinEventLimits(payload)).toBeUndefined();
  });

  it('keeps the user agent and every other string of context and addons out of the card number filter', () => {
    const { payload } = eventMessage(scenario().context);

    expect(looksLikeCardNumber(payload.context)).toBe(false);
    expect(looksLikeCardNumber(payload.addons)).toBe(false);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
  });
});

describe('withinEventLimits', () => {
  const ok = { title: 'x',
    context: { a: 'x' },
    addons: {},
    backtrace: [] };

  it('accepts values at the maximum', () => {
    const keys = Object.fromEntries(Array.from({ length: EVENT_LIMITS.keys - 1 }, (_, index) => [`k${String(index)}`, 'y'.repeat(EVENT_LIMITS.string)]));

    expect(withinEventLimits({ ...ok,
      title: 't'.repeat(EVENT_LIMITS.title),
      context: { ...keys,
        list: [] },
      backtrace: [{ sourceCode: Array.from({ length: EVENT_LIMITS.sourceLines }, () => ({ line: 1,
        content: 'z'.repeat(EVENT_LIMITS.sourceLine) })) }] })).toBeUndefined();
  });

  it('names the first value over a limit', () => {
    expect(withinEventLimits({ ...ok,
      title: 't'.repeat(401) })).toContain('title');
    expect(withinEventLimits({ ...ok,
      context: { long: 'y'.repeat(201) } })).toContain('context.long');
    expect(withinEventLimits({ ...ok,
      addons: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${String(index)}`, 1])) })).toContain('addons');
    expect(withinEventLimits({ ...ok,
      context: { list: Array.from({ length: 11 }, () => 1) } })).toContain('context.list');
    expect(withinEventLimits({ ...ok,
      context: { a: { b: { c: { d: { e: { f: 1 } } } } } } })).toContain('depth');
    expect(withinEventLimits({ ...ok,
      backtrace: [{ sourceCode: Array.from({ length: 22 }, () => ({ line: 1,
        content: 'z' })) }] })).toContain('sourceCode');
    expect(withinEventLimits({ ...ok,
      backtrace: [{ sourceCode: [{ line: 1,
        content: 'z'.repeat(141) }] }] })).toContain('sourceCode');
  });
});

/** Paths of the fields the card is compared on, one per value the event sends. */
