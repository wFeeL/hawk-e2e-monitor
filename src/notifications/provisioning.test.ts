import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphqlTransport } from '../clients/graphql.js';
import { createHawkApi } from '../clients/hawk-api.js';
import type { HawkApi } from '../clients/hawk-api.js';
import { CheckError, isCheckError } from '../errors/taxonomy.js';
import { createFakeClock } from '../test-support/fake-clock.js';
import type { FakeClock } from '../test-support/fake-clock.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeHawk } from '../test-support/fake-hawk/index.js';
import { systemClock } from '../time/clock.js';
import type { PublicAddress } from './address.js';
import { createProvisioner, desiredRule, ruleProjection } from './provisioning.js';
import type { Provisioner, ProvisionerDeps } from './provisioning.js';
import type { NotificationRule } from './types.js';

const SECRET = 'provisioning-secret-0123456789abc';
const INSTANCE = 'prov';
const WARMUP_MS = 65_000;

let hawk: FakeHawk;
let clock: FakeClock;
let signal: AbortSignal;

/**
 * Builds a public address.
 * @param host Hostname.
 * @param source Where it came from.
 * @returns Address on https.
 */
function address(host = 'one.example.com', source: PublicAddress['source'] = 'config'): PublicAddress {
  return { baseUrl: `https://${host}`,
    hostname: host,
    source };
}

/**
 * Builds a client of the fake with short retries.
 * @param httpTimeoutMs Deadline of one request.
 * @returns Client.
 */
function apiFor(httpTimeoutMs = 1000): HawkApi {
  return createHawkApi({ transport: createGraphqlTransport({ url: hawk.api.url,
    httpTimeoutMs,
    clock: systemClock,
    retryDelaysMs: [1, 1] }),
  email: hawk.email,
  password: hawk.password,
  clock: systemClock,
  retryDelaysMs: [1] });
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
    ...overrides };
}

/**
 * Builds a provisioner.
 * @param overrides Replaced dependencies.
 * @returns Provisioner on the fake.
 */
function provisioner(overrides: Partial<ProvisionerDeps> = {}): Provisioner {
  return createProvisioner(depsOf(overrides));
}

/**
 * Lists the rules that belong to the instance.
 * @returns Our rules in the fake.
 */
function ours(): NotificationRule[] {
  return hawk.rules.list(hawk.projectId).filter(rule => rule.including.join() === `[e2e:${INSTANCE}]`);
}

/**
 * Lists mutations the fake received.
 * @returns Names of rule mutations.
 */
function mutations(): string[] {
  return hawk.api.operations.filter(name => /^(Create|Update|Delete)NotificationRule$/u.test(name));
}

/**
 * Runs a call and returns the taxonomy error it throws.
 * @param promise Call promise.
 * @returns The thrown error.
 */
async function checkErrorOf(promise: Promise<unknown>): Promise<CheckError> {
  try {
    await promise;
  } catch (error) {
    if (isCheckError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected the call to fail');
}

beforeEach(async () => {
  hawk = await startFakeHawk();
  clock = createFakeClock();
  signal = new AbortController().signal;
});

afterEach(async () => {
  await hawk.close();
});

describe('desiredRule', () => {
  it('has the fields of the spec and no secret outside the endpoints', () => {
    const rule = desiredRule(depsOf(), address());

    expect(rule).toMatchObject({ projectId: hawk.projectId,
      isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: [`[e2e:${INSTANCE}]`],
      excluding: ['send-and-receive-event'] });
    expect(rule.channels.webhook).toEqual({ isEnabled: true,
      endpoint: `https://one.example.com/hooks/webhook/${SECRET}` });
    expect(rule.channels.loop).toEqual({ isEnabled: true,
      endpoint: `https://one.example.com/hooks/loop/${SECRET}` });
    expect(rule.channels.email).toEqual({ isEnabled: false,
      endpoint: '' });
  });

  it('turns the loop off by the setting', () => {
    expect(desiredRule(depsOf({ loop: false }), address()).channels.loop.isEnabled).toBe(false);
  });
});

describe('ruleProjection', () => {
  it('ignores ids, minPeriod and thresholds', () => {
    const desired = desiredRule(depsOf(), address());
    const stored: NotificationRule = { id: 'x',
      isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: desired.including,
      excluding: desired.excluding,
      threshold: null,
      thresholdPeriod: null,
      channels: { ...desired.channels,
        email: { ...desired.channels.email,
          minPeriod: 60 } } };

    expect(ruleProjection(stored)).toBe(ruleProjection(desired));
  });

  it('differs when an address differs', () => {
    expect(ruleProjection(desiredRule(depsOf(), address('a.example.com')))).not.toBe(ruleProjection(desiredRule(depsOf(), address('b.example.com'))));
  });
});

describe('provision', () => {
  it('empty project creates', async () => {
    const result = await provisioner().provision(address(), signal);

    expect(result).toMatchObject({ action: 'created',
      deleted: 0,
      matchChanged: true });
    expect(ours()).toHaveLength(1);
    expect(ours()[0]?.id).toBe(result.ruleId);
    expect(ours()[0]?.channels.webhook?.endpoint).toBe(`https://one.example.com/hooks/webhook/${SECRET}`);
  });

  it('second run is none without mutations', async () => {
    const same = provisioner();

    await same.provision(address(), signal);

    const before = mutations().length;
    const result = await same.provision(address(), signal);

    expect(result).toMatchObject({ action: 'none',
      deleted: 0,
      matchChanged: false });
    expect(mutations()).toHaveLength(before);
  });

  it('address change updates without match change', async () => {
    const same = provisioner();

    await same.provision(address(), signal);

    const result = await same.provision(address('two.example.com'), signal);

    expect(result).toMatchObject({ action: 'updated',
      matchChanged: false });
    expect(ours()[0]?.channels.webhook?.endpoint).toContain('two.example.com');
  });

  it('loop toggle is a match change', async () => {
    await provisioner().provision(address(), signal);

    const result = await provisioner({ loop: false }).provision(address(), signal);

    expect(result).toMatchObject({ action: 'updated',
      matchChanged: true });
    expect(ours()[0]?.channels.loop.isEnabled).toBe(false);
  });

  it('two of ours leave one without a match change', async () => {
    await provisioner().provision(address(), signal);

    const [rule] = ours();

    hawk.rules.seed(hawk.projectId, { ...rule as NotificationRule,
      id: 'e'.repeat(24) });

    const result = await provisioner().provision(address(), signal);

    expect(result).toMatchObject({ action: 'none',
      deleted: 1,
      matchChanged: false });
    expect(ours()).toHaveLength(1);
    expect(result.ruleId).toBe(ours()[0]?.id);
  });

  it('foreign and default rules untouched', async () => {
    const foreign: NotificationRule = { ...hawk.rules.list(hawk.projectId)[0] as NotificationRule,
      id: 'd'.repeat(24),
      including: ['payments'] };

    hawk.rules.seed(hawk.projectId, foreign);

    const before = hawk.rules.list(hawk.projectId);

    await provisioner().provision(address(), signal);
    await provisioner({ loop: false }).provision(address('two.example.com'), signal);

    expect(hawk.rules.list(hawk.projectId).filter(rule => rule.including.join() !== `[e2e:${INSTANCE}]`)).toEqual(before);
  });

  it('a leftover rule that does not go away is provisioning_conflict', async () => {
    await provisioner().provision(address(), signal);
    hawk.rules.seed(hawk.projectId, { ...ours()[0] as NotificationRule,
      id: 'e'.repeat(24) });

    const api = apiFor();
    const error = await checkErrorOf(provisioner({ api: { ...api,
      deleteNotificationRule: async () => Promise.resolve() } }).provision(address(), signal));

    expect(error.errorClass).toBe('provisioning_conflict');
  });

  it('create timeout rereads and marks warmup', async () => {
    hawk.api.knobs.createThenHang = true;

    const same = provisioner({ api: apiFor(100) });
    const result = await same.provision(address(), signal);

    expect(result).toMatchObject({ action: 'none',
      matchChanged: true });
    expect(ours()).toHaveLength(1);
    expect(hawk.api.operations.filter(name => name === 'CreateNotificationRule')).toHaveLength(1);
    expect(same.warmupRemainingMs()).toBe(WARMUP_MS);
  });

  describe('the warmup starts before a mutation that changes matching, whatever happens next', () => {
    /**
     * Wraps the read so that its n-th call fails.
     * @param api Real client.
     * @param failing Number of the call that fails, from 1.
     * @returns Client whose read fails once.
     */
    function failingRead(api: HawkApi, failing: number): HawkApi {
      let calls = 0;

      return { ...api,
        notificationRules: async (projectId, callSignal) => {
          calls += 1;

          if (calls === failing) {
            throw new CheckError('api_unavailable', { code: 'ECONNRESET' });
          }

          return api.notificationRules(projectId, callSignal);
        } };
    }

    /**
     * Leaves two rules of the instance in the fake, so that the next provision deletes one.
     * @returns Nothing.
     */
    async function seedTwoOfOurs(): Promise<void> {
      await provisioner().provision(address(), signal);
      hawk.rules.seed(hawk.projectId, { ...ours()[0] as NotificationRule,
        id: 'e'.repeat(24) });
    }

    it('an unknown outcome of create followed by a failed reread', async () => {
      hawk.api.knobs.createThenHang = true;

      const same = provisioner({ api: failingRead(apiFor(100), 2) });
      const error = await checkErrorOf(same.provision(address(), signal));

      expect(error.errorClass).toBe('api_unavailable');
      expect(ours()).toHaveLength(1);
      expect(same.warmupRemainingMs()).toBe(WARMUP_MS);
    });

    it('a failed delete of the extra rule after an update of matching', async () => {
      await seedTwoOfOurs();

      const same = provisioner({ loop: false,
        api: { ...apiFor(),
          deleteNotificationRule: async () => Promise.reject(new CheckError('api_unavailable', { code: 'ECONNRESET' })) } });

      await checkErrorOf(same.provision(address(), signal));

      expect(same.warmupRemainingMs()).toBe(WARMUP_MS);
    });

    it('a failed reread after the extra rule was deleted', async () => {
      await seedTwoOfOurs();

      const same = provisioner({ loop: false,
        api: failingRead(apiFor(), 2) });

      await checkErrorOf(same.provision(address(), signal));

      expect(same.warmupRemainingMs()).toBe(WARMUP_MS);
    });

    it('a failed delete after an update of the address only does not start it', async () => {
      await seedTwoOfOurs();

      const same = provisioner({ api: { ...apiFor(),
        deleteNotificationRule: async () => Promise.reject(new CheckError('api_unavailable', { code: 'ECONNRESET' })) } });

      await checkErrorOf(same.provision(address('two.example.com'), signal));

      expect(same.warmupRemainingMs()).toBe(0);
    });

    it('a success does not move the start back', async () => {
      const same = provisioner();

      await same.provision(address(), signal);
      await clock.advance(1000);

      expect(same.warmupRemainingMs()).toBe(WARMUP_MS - 1000);
    });
  });

  it('create that failed before sending is not hidden', async () => {
    const api = apiFor();
    const error = await checkErrorOf(provisioner({ api: { ...api,
      createNotificationRule: async () => Promise.reject(new CheckError('dns_error', { code: 'ENOTFOUND' })) } }).provision(address(), signal));

    expect(error.errorClass).toBe('dns_error');
  });

  it('update null twice is provisioning_conflict', async () => {
    await provisioner().provision(address(), signal);

    const api = apiFor();
    let calls = 0;
    const error = await checkErrorOf(provisioner({ api: { ...api,
      updateNotificationRule: async () => {
        calls += 1;

        return Promise.resolve(null);
      } } }).provision(address('two.example.com'), signal));

    expect(error.errorClass).toBe('provisioning_conflict');
    expect(calls).toBe(2);
  });

  it('update null once decides again', async () => {
    await provisioner().provision(address(), signal);

    const api = apiFor();
    let calls = 0;
    const result = await provisioner({ api: { ...api,
      updateNotificationRule: async (input, abort) => {
        calls += 1;

        return calls === 1 ? Promise.resolve(null) : api.updateNotificationRule(input, abort);
      } } }).provision(address('two.example.com'), signal);

    expect(result.action).toBe('updated');
    expect(calls).toBe(2);
  });

  it('cannot resolve via tunnel is tunnel_unavailable', async () => {
    hawk.api.knobs.unresolvableHosts = ['fresh.trycloudflare.com'];

    const error = await checkErrorOf(provisioner().provision(address('fresh.trycloudflare.com', 'tunnel'), signal));

    expect(error.errorClass).toBe('tunnel_unavailable');
    expect(error.message).toContain('Hawk cannot resolve the tunnel hostname: Cannot resolve webhook hostname');
  });

  it('cannot resolve via config is notification_endpoint_rejected', async () => {
    hawk.api.knobs.unresolvableHosts = ['gone.example.com'];

    const error = await checkErrorOf(provisioner().provision(address('gone.example.com'), signal));

    expect(error.errorClass).toBe('notification_endpoint_rejected');
    expect(error.facts.channel).toBe('webhook');
    expect(error.facts.detail).toContain('Cannot resolve webhook hostname "gone.example.com"');
  });

  it('another validator text is notification_endpoint_rejected', async () => {
    hawk.api.knobs.allowPrivateWebhook = false;

    const error = await checkErrorOf(provisioner().provision(address('localhost'), signal));

    expect(error.errorClass).toBe('notification_endpoint_rejected');
    expect(error.facts.detail).toContain('is not allowed');
  });

  it('not admin is api_forbidden with admin text', async () => {
    hawk.api.knobs.errors = Object.fromEntries([['CreateNotificationRule', { code: 'FORBIDDEN',
      message: 'Not enough permissions' }]]);

    const error = await checkErrorOf(provisioner().provision(address(), signal));

    expect(error.errorClass).toBe('api_forbidden');
    expect(error.message).toContain('Not enough permissions: the monitor user must be an admin of the project workspace');
  });

  it('provisioning_unstable on two match changes', async () => {
    const same = provisioner();

    await same.provision(address(), signal);

    const [rule] = ours();

    hawk.rules.update(hawk.projectId, { ...desiredRule(depsOf(), address()),
      ruleId: rule?.id,
      isEnabled: false });

    const error = await checkErrorOf(same.provision(address(), signal));

    expect(error.errorClass).toBe('provisioning_unstable');
    expect(error.facts.detail).toBe('isEnabled');
  });

  it('warmupRemainingMs counts down on the fake clock', async () => {
    const same = provisioner();

    expect(same.warmupRemainingMs()).toBe(0);

    await same.provision(address(), signal);
    expect(same.warmupRemainingMs()).toBe(WARMUP_MS);

    await clock.advance(5000);
    expect(same.warmupRemainingMs()).toBe(WARMUP_MS - 5000);

    await clock.advance(WARMUP_MS);
    expect(same.warmupRemainingMs()).toBe(0);
  });
});
