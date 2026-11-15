import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphqlTransport } from '../../src/clients/graphql.js';
import { createHawkApi } from '../../src/clients/hawk-api.js';
import type { HawkApi } from '../../src/clients/hawk-api.js';
import { isCheckError } from '../../src/errors/taxonomy.js';
import type { PublicAddress } from '../../src/notifications/address.js';
import { createProvisioner, desiredTelegramRule, ruleProjection } from '../../src/notifications/provisioning.js';
import type { Provisioner, ProvisionerDeps } from '../../src/notifications/provisioning.js';
import type { NotificationRule } from '../../src/notifications/types.js';
import { systemClock } from '../../src/time/clock.js';
import { createFakeClock } from '../support/fake-clock.js';
import type { FakeClock } from '../support/fake-clock.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';

const SECRET = 'provisioning-secret-0123456789abc';
const INSTANCE = 'prov';
const NOTIFY_URL = 'https://notify.bot.codex.so/u/abc123';
const WARMUP_MS = 65_000;
const ADDRESS: PublicAddress = { baseUrl: 'https://one.example.com',
  hostname: 'one.example.com',
  source: 'config' };

let hawk: FakeHawk;
let clock: FakeClock;
let signal: AbortSignal;

/**
 * Builds a client of the fake with short retries.
 * @returns Client.
 */
function apiFor(): HawkApi {
  return createHawkApi({ transport: createGraphqlTransport({ url: hawk.api.url,
    httpTimeoutMs: 1000,
    clock: systemClock,
    retry: { attempts: 3,
      delaysMs: [1, 1] } }),
  email: hawk.email,
  password: hawk.password,
  clock: systemClock,
  retry: { attempts: 3,
    delaysMs: [1] } });
}

/**
 * Builds dependencies of a provisioner.
 * @param overrides Replaced fields.
 * @returns Dependencies on the fake.
 */
function depsOf(overrides: Partial<ProvisionerDeps> = {}): ProvisionerDeps {
  return { api: apiFor(),
    clock,
    projectId: hawk.projectId,
    instanceId: INSTANCE,
    secret: SECRET,
    loop: true,
    warmupMs: WARMUP_MS,
    notifyUrl: NOTIFY_URL,
    ...overrides };
}

/**
 * Builds the provisioner of check-notification.
 * @param overrides Replaced dependencies.
 * @returns Provisioner of the new-events and threshold rules.
 */
function notificationProvisioner(overrides: Partial<ProvisionerDeps> = {}): Provisioner {
  return createProvisioner(depsOf({ kinds: ['newEvents', 'threshold'],
    ...overrides }));
}

/**
 * Builds the provisioner of telegram-delivery.
 * @param overrides Replaced dependencies.
 * @returns Provisioner of rule T.
 */
function telegramProvisioner(overrides: Partial<ProvisionerDeps> = {}): Provisioner {
  return createProvisioner(depsOf({ kinds: ['telegram'],
    ...overrides }));
}

/**
 * Lists the rules of the instance.
 * @returns Our rules in the fake.
 */
function ours(): NotificationRule[] {
  return hawk.rules.list(hawk.projectId).filter(rule => rule.including.join() === `[e2e:${INSTANCE}]`);
}

/**
 * Lists the rules of the instance that send to Telegram.
 * @returns Rules T in the fake.
 */
function telegramRules(): NotificationRule[] {
  return ours().filter(rule => rule.channels.telegram.isEnabled);
}

/**
 * Lists the rule mutations the fake received.
 * @returns Names of the mutations.
 */
function mutations(): string[] {
  return hawk.api.operations.filter(name => /^(Create|Update|Delete)NotificationRule$/u.test(name));
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  clock = createFakeClock();
  signal = new AbortController().signal;
});

afterEach(async () => {
  await hawk.close();
});

describe('desiredTelegramRule', () => {
  it('sends to Telegram and to the webhook of its own path, with all four channel objects', () => {
    const rule = desiredTelegramRule(depsOf(), ADDRESS);

    expect(rule).toMatchObject({ projectId: hawk.projectId,
      isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: [`[e2e:${INSTANCE}]`] });
    expect(rule.channels.telegram).toEqual({ isEnabled: true,
      endpoint: NOTIFY_URL });
    expect(rule.channels.webhook).toEqual({ isEnabled: true,
      endpoint: `https://one.example.com/hooks/telegram/${SECRET}` });
    expect(rule.channels.email.isEnabled).toBe(false);
    expect(rule.channels.slack.isEnabled).toBe(false);
    expect(rule.channels.loop.isEnabled).toBe(false);
    expect(Object.keys(rule.channels).toSorted()).toEqual(['email', 'loop', 'slack', 'telegram', 'webhook']);
  });

  it('excludes every event scenario but telegram-delivery', () => {
    expect(desiredTelegramRule(depsOf(), ADDRESS).excluding).toEqual(['send-and-receive-event', 'check-notification', 'new-project', 'sourcemaps', 'sentry-envelope']);
  });

  it('needs the notify URL', () => {
    expect(() => desiredTelegramRule(depsOf({ notifyUrl: undefined }), ADDRESS)).toThrow('TELEGRAM_NOTIFY_URL');
  });
});

describe('telegram rule provisioner', () => {
  it('creates rule T and reports its id, not the ids of the other rules', async () => {
    const result = await telegramProvisioner().provision(ADDRESS, signal);

    expect(result).toMatchObject({ action: 'created',
      deleted: 0,
      matchChanged: true });
    expect(result.telegramRuleId).toBe(telegramRules()[0]?.id);
    expect(result.ruleId).toBeUndefined();
    expect(result.thresholdRuleId).toBeUndefined();
    expect(ours()).toHaveLength(1);
    expect(ruleProjection(telegramRules()[0] as NotificationRule)).toBe(ruleProjection(desiredTelegramRule(depsOf(), ADDRESS)));
  });

  it('the check-notification provisioner still reports its own two ids', async () => {
    const result = await notificationProvisioner().provision(ADDRESS, signal);

    expect(result.ruleId).toBeDefined();
    expect(result.thresholdRuleId).toBeDefined();
    expect(result.telegramRuleId).toBeUndefined();
  });

  it('both provisioners in turn, two rounds: nothing is created or deleted after the first round', async () => {
    const notification = notificationProvisioner();
    const telegram = telegramProvisioner();

    expect((await notification.provision(ADDRESS, signal)).action).toBe('created');
    expect((await telegram.provision(ADDRESS, signal)).action).toBe('created');
    expect(ours()).toHaveLength(3);

    const before = mutations().length;

    for (const provisioner of [notification, telegram]) {
      expect(await provisioner.provision(ADDRESS, signal)).toMatchObject({ action: 'none',
        deleted: 0,
        matchChanged: false });
    }

    expect(mutations()).toHaveLength(before);
    expect(ours()).toHaveLength(3);
  });

  it('the check-notification provisioner never touches rule T, and rule T provisioner never touches the other two', async () => {
    await telegramProvisioner().provision(ADDRESS, signal);

    const [telegramRule] = telegramRules();
    const afterTelegram = mutations().length;

    await notificationProvisioner().provision(ADDRESS, signal);

    expect(telegramRules().map(rule => rule.id)).toEqual([telegramRule?.id]);
    expect(mutations().slice(afterTelegram)).toEqual(['CreateNotificationRule', 'CreateNotificationRule']);

    const before = mutations().length;

    await telegramProvisioner().provision(ADDRESS, signal);

    expect(mutations()).toHaveLength(before);
  });

  it('deletes an extra rule T and nothing else', async () => {
    await notificationProvisioner().provision(ADDRESS, signal);
    await telegramProvisioner().provision(ADDRESS, signal);
    hawk.rules.create(hawk.projectId, { ...desiredTelegramRule(depsOf(), ADDRESS) });

    expect(telegramRules()).toHaveLength(2);

    const result = await telegramProvisioner().provision(ADDRESS, signal);

    expect(result).toMatchObject({ deleted: 1,
      action: 'none' });
    expect(telegramRules()).toHaveLength(1);
    expect(ours()).toHaveLength(3);
  });

  it('a change of the notify address only is an update without a match change', async () => {
    await telegramProvisioner().provision(ADDRESS, signal);

    const result = await telegramProvisioner({ notifyUrl: 'https://notify.bot.codex.so/u/other456' }).provision(ADDRESS, signal);

    expect(result).toMatchObject({ action: 'updated',
      matchChanged: false });
    expect(telegramRules()[0]?.channels.telegram.endpoint).toBe('https://notify.bot.codex.so/u/other456');
  });

  it('a change of the receiver address only is an update without a match change', async () => {
    await telegramProvisioner().provision(ADDRESS, signal);

    const result = await telegramProvisioner().provision({ ...ADDRESS,
      baseUrl: 'https://two.example.com',
      hostname: 'two.example.com' }, signal);

    expect(result).toMatchObject({ action: 'updated',
      matchChanged: false });
  });

  it('each provisioner keeps its own warmup and reports its own match changes', async () => {
    const changes: string[] = [];
    const notification = notificationProvisioner({ onMatchChange: () => changes.push('notification') });
    const telegram = telegramProvisioner({ onMatchChange: () => changes.push('telegram') });

    await notification.provision(ADDRESS, signal);
    expect(notification.warmupRemainingMs()).toBe(WARMUP_MS);
    expect(telegram.warmupRemainingMs()).toBe(0);

    await clock.advance(WARMUP_MS);
    await telegram.provision(ADDRESS, signal);

    expect(notification.warmupRemainingMs()).toBe(0);
    expect(telegram.warmupRemainingMs()).toBe(WARMUP_MS);
    expect(changes).toContain('telegram');
    expect(changes.filter(name => name === 'notification').length).toBeGreaterThan(0);
  });

  it('a provisioner without kinds keeps the two rules of check-notification', async () => {
    await createProvisioner(depsOf()).provision(ADDRESS, signal);

    expect(ours().map(rule => rule.whatToReceive)
      .toSorted()).toEqual(['ONLY_NEW', 'SEEN_MORE']);
    expect(telegramRules()).toEqual([]);
  });

  it('fails clearly when the notify URL is missing', async () => {
    try {
      await telegramProvisioner({ notifyUrl: undefined }).provision(ADDRESS, signal);
    } catch (error) {
      expect(isCheckError(error) && error.errorClass).toBe('monitor_internal');

      return;
    }

    throw new Error('Expected the provisioner to fail');
  });
});
