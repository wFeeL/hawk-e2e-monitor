import { describe, expect, it } from 'vitest';
import { testConfig } from '../../test-support/config.js';
import { buildTitle, chooseTransport, createRunId, planRun, shouldRepeat } from './plan.js';

describe('chooseTransport', () => {
  it.each([[1, 'http'], [2, 'ws'], [3, 'http'], [4, 'ws']] as const)('alternate: run %i uses %s', (sequence, expected) => {
    expect(chooseTransport(sequence, 'alternate')).toBe(expected);
  });

  it('fixed modes ignore the number', () => {
    expect(chooseTransport(1, 'ws')).toBe('ws');
    expect(chooseTransport(2, 'http')).toBe('http');
  });
});

describe('shouldRepeat', () => {
  it.each([[1, false], [2, false], [3, true], [4, true], [5, false]] as const)('alternate, N=2: run %i repeats %s', (sequence, expected) => {
    expect(shouldRepeat(sequence, 'alternate', 2)).toBe(expected);
  });

  it('N=0 never repeats', () => {
    for (const mode of ['alternate', 'http', 'ws'] as const) {
      expect(shouldRepeat(6, mode, 0)).toBe(false);
    }
  });

  it('fixed mode uses sequence % N', () => {
    expect(shouldRepeat(4, 'http', 2)).toBe(true);
    expect(shouldRepeat(3, 'http', 2)).toBe(false);
    expect(shouldRepeat(6, 'ws', 3)).toBe(true);
  });
});

describe('createRunId', () => {
  it('is r and 15 lowercase letters', () => {
    expect(createRunId()).toMatch(/^r[a-z]{15}$/u);
  });

  it('takes its letters from the injected source', () => {
    expect(createRunId(count => 'x'.repeat(count))).toBe(`r${'x'.repeat(15)}`);
  });
});

describe('buildTitle', () => {
  it('has the instance id, the run id and the scenario name', () => {
    expect(buildTitle('mon-1', 'rabc', 'send-and-receive-event')).toBe('[e2e:mon-1] rabc send-and-receive-event');
  });

  it('title of check-notification', () => {
    expect(buildTitle('mon-1', 'rabc', 'check-notification')).toBe('[e2e:mon-1] rabc check-notification');
  });
});

describe('planRun', () => {
  const letters = (count: number): string => 'a'.repeat(count);

  it('http run: nodejs catcher, context and title', () => {
    const plan = planRun(testConfig({ instanceId: 'mon' }), { sequence: 3 }, 'send-and-receive-event', letters);

    expect(plan).toEqual({
      runId: `r${'a'.repeat(15)}`,
      sequence: 3,
      transport: 'http',
      catcherType: 'errors/nodejs',
      repeat: false,
      title: `[e2e:mon] r${'a'.repeat(15)} send-and-receive-event`,
      context: { runId: `r${'a'.repeat(15)}`,
        instanceId: 'mon',
        scenario: 'send-and-receive-event',
        transport: 'http',
        sequence: 3 },
    });
  });

  it('check-notification puts its name in the title and the context', () => {
    const plan = planRun(testConfig({ instanceId: 'mon' }), { sequence: 1 }, 'check-notification', letters);

    expect(plan.title).toBe(`[e2e:mon] r${'a'.repeat(15)} check-notification`);
    expect(plan.context.scenario).toBe('check-notification');
  });

  it('ws run uses the javascript catcher', () => {
    expect(planRun(testConfig(), { sequence: 2 }, 'send-and-receive-event', letters).catcherType).toBe('errors/javascript');
  });

  it('computes repeat from the config', () => {
    const config = testConfig({ repeatEveryNRuns: 2 });

    expect(planRun(config, { sequence: 4 }, 'send-and-receive-event', letters).repeat).toBe(true);
    expect(planRun(config, { sequence: 5 }, 'send-and-receive-event', letters).repeat).toBe(false);
  });

  it('options override transport and repeat', () => {
    const plan = planRun(testConfig({ repeatEveryNRuns: 0 }), { sequence: 1,
      transport: 'ws',
      repeat: true }, 'send-and-receive-event', letters);

    expect(plan.transport).toBe('ws');
    expect(plan.catcherType).toBe('errors/javascript');
    expect(plan.repeat).toBe(true);
    expect(plan.context.transport).toBe('ws');
  });
});
