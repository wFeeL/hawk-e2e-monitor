import { describe, expect, it } from 'vitest';
import type { NotificationRule } from '../../../src/notifications/types.js';
import { createFakeRules, defaultRule } from './rules.js';
import type { FakeRuleError, FakeRules } from './rules.js';

const PROJECT = 'a'.repeat(24);
const OTHER_PROJECT = 'b'.repeat(24);
const EM_DASH_PORT = (port: number): string => `Webhook URL port ${String(port)} is not allowed — only 80 (http) and 443 (https)`;
const TYPE_ERROR = `Cannot read properties of undefined (reading 'isEnabled')`;

/** A boolean the tests flip. */
interface Switch {
  /** Current value. */
  value: boolean;
}

/** A fake rule store with the switches the tests flip. */
interface Harness {
  /** Store under test. */
  rules: FakeRules;
  /** Value `allowPrivateWebhook` answers. */
  allowPrivate: Switch;
  /** Hosts `resolves` rejects. */
  unresolvable: Set<string>;
}

/** Channel settings as sent. */
interface ChannelInput {
  /** On or off. */
  isEnabled?: boolean;
  /** Where to deliver. */
  endpoint: string;
  /** Seconds between notifications. */
  minPeriod?: number;
}

/**
 * Creates a store with numbered ids.
 * @param allowPrivate Initial answer of `allowPrivateWebhook`.
 * @returns Store and its switches.
 */
function harness(allowPrivate = false): Harness {
  const switches = { value: allowPrivate };
  const unresolvable = new Set<string>();
  let counter = 0;
  const rules = createFakeRules({ allowPrivateWebhook: () => switches.value,
    resolves: host => !unresolvable.has(host) }, () => {
    counter += 1;

    return `rule${String(counter)}`;
  });

  return { rules,
    allowPrivate: switches,
    unresolvable };
}

/**
 * Builds a rule input; `channels` entries replace the defaults, `undefined` removes a channel.
 * @param channels Channel overrides.
 * @param extra Other input fields.
 * @returns Input with all four mandatory channels and a webhook.
 */
function input(channels: Record<string, ChannelInput | undefined> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, ChannelInput | undefined> = {
    email: { isEnabled: false,
      endpoint: '' },
    slack: { isEnabled: false,
      endpoint: '' },
    loop: { isEnabled: false,
      endpoint: '' },
    telegram: { isEnabled: false,
      endpoint: '' },
    webhook: { endpoint: 'https://example.com/hooks/webhook/s' },
    ...channels,
  };

  return { projectId: PROJECT,
    channels: Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined)),
    ...extra };
}

/**
 * Tells a rule from an error.
 * @param result Return value of `create` or `update`.
 * @returns The error, failing when the value is a rule or null.
 */
function errorOf(result: NotificationRule | FakeRuleError | null): FakeRuleError {
  if (result === null || !('code' in result)) {
    throw new Error(`Expected an error, got ${JSON.stringify(result)}`);
  }

  return result;
}

/**
 * Takes a rule out of a result that must be one.
 * @param result What `create` or `update` returned.
 * @returns The rule, or a thrown failure when the result was an error.
 */
function ruleOf(result: NotificationRule | FakeRuleError | null): NotificationRule {
  if (result === null || 'code' in result) {
    throw new Error(`Expected a rule, got ${JSON.stringify(result)}`);
  }

  return result;
}

/**
 * Creates a rule and returns its error text.
 * @param h Harness.
 * @param body Rule input.
 * @returns The message of the error.
 */
function messageOf(h: Harness, body: Record<string, unknown>): string {
  return errorOf(h.rules.create(PROJECT, body)).message;
}

describe('fake rules: mandatory channel objects', () => {
  it.each(['email', 'slack', 'loop', 'telegram'])('missing %s object is INTERNAL_SERVER_ERROR', (name) => {
    const h = harness();
    const created = errorOf(h.rules.create(PROJECT, input({ [name]: undefined })));
    const updated = errorOf(h.rules.update(PROJECT, { ...input({ [name]: undefined }),
      ruleId: 'x' }));

    expect(created).toEqual({ code: 'INTERNAL_SERVER_ERROR',
      message: TYPE_ERROR });
    expect(updated).toEqual(created);
    expect(h.rules.list(PROJECT)).toEqual([]);
  });

  it('a missing webhook is fine and stored as null', () => {
    const h = harness();
    const rule = ruleOf(h.rules.create(PROJECT, input({ webhook: undefined })));

    expect(rule.channels.webhook).toBeNull();
  });

  it('checks interleave like Hawk: a bad email wins over a missing slack', () => {
    const h = harness();
    const body = input({ email: { endpoint: 'nope' },
      slack: undefined });

    expect(messageOf(h, body)).toBe('Invalid email endpoint passed');
  });

  it('a missing slack wins when email is fine', () => {
    const h = harness();

    expect(errorOf(h.rules.create(PROJECT, input({ slack: undefined }))).code).toBe('INTERNAL_SERVER_ERROR');
  });
});

describe('fake rules: endpoints', () => {
  it('email, slack and telegram texts are literal', () => {
    const h = harness();

    expect(messageOf(h, input({ email: { endpoint: 'not an email' } }))).toBe('Invalid email endpoint passed');
    expect(messageOf(h, input({ slack: { endpoint: 'https://example.com/x' } }))).toBe('Invalid slack endpoint passed');
    expect(messageOf(h, input({ telegram: { endpoint: 'https://example.com/u/1' } }))).toBe('Invalid telegram endpoint passed');
  });

  it('valid email, slack and telegram endpoints pass', () => {
    const h = harness();
    const created = h.rules.create(PROJECT, input({ email: { endpoint: 'a@example.com' },
      slack: { endpoint: 'https://hooks.slack.com/services/T1/B2/c3' },
      telegram: { endpoint: 'https://notify.bot.codex.so/u/abc123' } }));

    expect(ruleOf(created).id).toBe('rule1');
  });

  it('loop must be https with /hooks/', () => {
    const h = harness(false);
    const loop = (endpoint: string): Record<string, unknown> => input({ loop: { endpoint } });

    expect(messageOf(h, loop('http://example.com/hooks/loop/s'))).toBe('Invalid loop endpoint passed');
    expect(messageOf(h, loop('https://example.com/loop/s'))).toBe('Invalid loop endpoint passed');
    expect(messageOf(h, loop('https://example.com/hooks/'))).toBe('Invalid loop endpoint passed');
    expect(h.rules.create(PROJECT, loop('https://example.com/hooks/loop/s'))).toMatchObject({ id: 'rule1' });
  });

  it('loop accepts http when private webhooks are allowed', () => {
    const h = harness(true);

    expect(h.rules.create(PROJECT, input({ loop: { endpoint: 'http://127.0.0.1:1234/hooks/loop/s' } }))).toMatchObject({ id: 'rule1' });
    expect(messageOf(h, input({ loop: { endpoint: 'http://127.0.0.1:1234/loop/s' } }))).toBe('Invalid loop endpoint passed');
  });

  it('disabled channels are not validated', () => {
    const h = harness();

    expect(h.rules.create(PROJECT, input({ email: { isEnabled: false,
      endpoint: 'garbage' },
    webhook: { isEnabled: false,
      endpoint: 'garbage' } }))).toMatchObject({ id: 'rule1' });
  });

  it.each([
    ['not a url', 'Invalid webhook URL'],
    ['ftp://example.com/x', 'Webhook URL must use http or https protocol'],
    ['https://example.com:8443/x', EM_DASH_PORT(8443)],
    ['https://example.com:80/x', EM_DASH_PORT(80)],
    ['http://example.com:443/x', EM_DASH_PORT(443)],
    ['https://localhost/x', 'Webhook hostname "localhost" is not allowed'],
    ['https://printer.local/x', 'Webhook hostname "printer.local" is not allowed'],
    ['https://db.internal/x', 'Webhook hostname "db.internal" is not allowed'],
    ['https://nas.lan/x', 'Webhook hostname "nas.lan" is not allowed'],
    ['https://host.localdomain/x', 'Webhook hostname "host.localdomain" is not allowed'],
    ['https://127.0.0.1/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://10.1.2.3/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://192.168.0.5/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://172.16.0.1/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://172.31.255.1/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://169.254.169.254/x', 'Webhook URL points to a private/reserved IP address'],
    ['https://100.64.0.1/x', 'Webhook URL points to a private/reserved IP address'],
  ])('webhook texts are literal: %s', (endpoint, text) => {
    const h = harness(false);

    expect(errorOf(h.rules.create(PROJECT, input({ webhook: { endpoint } })))).toEqual({ code: 'BAD_USER_INPUT',
      message: text });
  });

  it('public addresses pass: 172.32.x is not private', () => {
    const h = harness(false);

    expect(h.rules.create(PROJECT, input({ webhook: { endpoint: 'https://172.32.0.1/x' } }))).toMatchObject({ id: 'rule1' });
  });

  it('port 8443 rejected, 443 and 80 by scheme accepted', () => {
    const h = harness(false);

    expect(messageOf(h, input({ webhook: { endpoint: 'https://example.com:8443/x' } }))).toBe(EM_DASH_PORT(8443));
    expect(h.rules.create(PROJECT, input({ webhook: { endpoint: 'https://example.com:443/x' } }))).toMatchObject({ id: 'rule1' });
    expect(h.rules.create(PROJECT, input({ webhook: { endpoint: 'http://example.com:80/x' } }))).toMatchObject({ id: 'rule2' });
  });

  it('https on 80 rejected', () => {
    const h = harness(false);

    expect(messageOf(h, input({ webhook: { endpoint: 'https://example.com:80/x' } }))).toBe(EM_DASH_PORT(80));
  });

  it('unresolvable host rejected, also when private webhooks are allowed', () => {
    const h = harness(true);

    h.unresolvable.add('gone.example.com');

    expect(messageOf(h, input({ webhook: { endpoint: 'https://gone.example.com/x' } }))).toBe('Cannot resolve webhook hostname "gone.example.com"');
  });

  it('allowing private webhooks skips only the port and IP checks', () => {
    const h = harness(true);

    expect(h.rules.create(PROJECT, input({ webhook: { endpoint: 'http://127.0.0.1:54321/hooks/webhook/s' } }))).toMatchObject({ id: 'rule1' });
    expect(messageOf(h, input({ webhook: { endpoint: 'http://localhost:54321/x' } }))).toBe('Webhook hostname "localhost" is not allowed');
  });

  it('the switch is read on every call', () => {
    const h = harness(true);
    const body = input({ webhook: { endpoint: 'http://127.0.0.1:54321/x' } });

    expect(h.rules.create(PROJECT, body)).toMatchObject({ id: 'rule1' });
    h.allowPrivate.value = false;
    expect(messageOf(h, body)).toBe(EM_DASH_PORT(54_321));
  });
});

describe('fake rules: storage', () => {
  it('defaults are applied (minPeriod 60)', () => {
    const h = harness();
    const rule = ruleOf(h.rules.create(PROJECT, input()));

    expect(rule).toMatchObject({ id: 'rule1',
      isEnabled: true,
      whatToReceive: 'ONLY_NEW',
      including: [],
      excluding: [] });
    expect(rule.channels.webhook).toEqual({ isEnabled: true,
      endpoint: 'https://example.com/hooks/webhook/s',
      minPeriod: 60 });
    expect(rule.channels.email).toEqual({ isEnabled: false,
      endpoint: '',
      minPeriod: 60 });
    expect(h.rules.list(PROJECT)).toEqual([rule]);
  });

  it('explicit values win over defaults', () => {
    const h = harness();
    const rule = ruleOf(h.rules.create(PROJECT, input({ webhook: { isEnabled: false,
      endpoint: 'https://example.com/x',
      minPeriod: 5 } }, { isEnabled: false,
      including: ['a'],
      excluding: ['b'] })));

    expect(rule).toMatchObject({ isEnabled: false,
      including: ['a'],
      excluding: ['b'] });
    expect(rule.channels.webhook).toEqual({ isEnabled: false,
      endpoint: 'https://example.com/x',
      minPeriod: 5 });
  });

  it('new rule goes first', () => {
    const h = harness();

    h.rules.create(PROJECT, input());
    h.rules.create(PROJECT, input());

    expect(h.rules.list(PROJECT).map(rule => rule.id)).toEqual(['rule2', 'rule1']);
  });

  it('projects do not see each other', () => {
    const h = harness();

    h.rules.create(PROJECT, input());

    expect(h.rules.list(OTHER_PROJECT)).toEqual([]);
  });

  it('list returns copies', () => {
    const h = harness();

    h.rules.create(PROJECT, input());
    h.rules.list(PROJECT)[0]?.including.push('changed');
    h.rules.list(PROJECT).pop();

    expect(h.rules.list(PROJECT)).toHaveLength(1);
    expect(h.rules.list(PROJECT)[0]?.including).toEqual([]);
  });

  it('update replaces the rule as a whole and keeps its place', () => {
    const h = harness();

    h.rules.create(PROJECT, input());
    h.rules.create(PROJECT, input());

    const updated = ruleOf(h.rules.update(PROJECT, { ...input({}, { including: ['x'] }),
      ruleId: 'rule1' }));

    expect(updated).toMatchObject({ id: 'rule1',
      including: ['x'] });
    expect(h.rules.list(PROJECT).map(rule => rule.id)).toEqual(['rule2', 'rule1']);
    expect(h.rules.list(PROJECT)[1]?.including).toEqual(['x']);
  });

  it('update of unknown rule is null', () => {
    const h = harness();

    expect(h.rules.update(PROJECT, { ...input(),
      ruleId: 'nope' })).toBeNull();
  });

  it('update validates channels before looking for the rule', () => {
    const h = harness();

    expect(errorOf(h.rules.update(PROJECT, { ...input({ email: { endpoint: 'bad' } }),
      ruleId: 'nope' })).message).toBe('Invalid email endpoint passed');
  });

  it('delete removes and returns nothing', () => {
    const h = harness();

    h.rules.create(PROJECT, input());
    h.rules.create(PROJECT, input());

    expect(h.rules.remove(PROJECT, 'rule1')).toBeUndefined();
    expect(h.rules.list(PROJECT).map(rule => rule.id)).toEqual(['rule2']);
    expect(h.rules.remove(PROJECT, 'rule1')).toBeUndefined();
    expect(h.rules.list(PROJECT)).toHaveLength(1);
  });

  it('seed stores a rule as it is, in front', () => {
    const h = harness();
    const seeded = defaultRule('me@example.com', () => 'seeded');

    h.rules.create(PROJECT, input());
    h.rules.seed(PROJECT, seeded);

    expect(h.rules.list(PROJECT)[0]).toEqual(seeded);
  });

  it('version grows on every change and stays on a miss', () => {
    const h = harness();

    expect(h.rules.version(PROJECT)).toBe(0);
    h.rules.create(PROJECT, input());
    expect(h.rules.version(PROJECT)).toBe(1);
    h.rules.update(PROJECT, { ...input(),
      ruleId: 'rule1' });
    expect(h.rules.version(PROJECT)).toBe(2);
    h.rules.seed(PROJECT, defaultRule('a@example.com', () => 's'));
    expect(h.rules.version(PROJECT)).toBe(3);
    h.rules.remove(PROJECT, 'rule1');
    expect(h.rules.version(PROJECT)).toBe(4);
    h.rules.remove(PROJECT, 'rule1');
    h.rules.update(PROJECT, { ...input(),
      ruleId: 'rule1' });
    h.rules.create(PROJECT, input({ email: { endpoint: 'bad' } }));
    expect(h.rules.version(PROJECT)).toBe(4);
    expect(h.rules.version(OTHER_PROJECT)).toBe(0);
  });

  it.each([
    ['not an object', 'text'],
    ['channels missing', { projectId: PROJECT }],
    ['channels is a string', { projectId: PROJECT,
      channels: 'x' }],
    ['endpoint is not a string', { projectId: PROJECT,
      channels: { email: { endpoint: 5 } } }],
    ['unknown whatToReceive', { ...input(),
      whatToReceive: 'ALL' }],
    ['including is not a list', { ...input(),
      including: 'x' }],
  ])('invalid input is BAD_USER_INPUT: %s', (_name, body) => {
    const h = harness();

    expect(errorOf(h.rules.create(PROJECT, body)).code).toBe('BAD_USER_INPUT');
    expect(h.rules.list(PROJECT)).toEqual([]);
  });

  it('update without a ruleId is BAD_USER_INPUT', () => {
    const h = harness();

    expect(errorOf(h.rules.update(PROJECT, input())).code).toBe('BAD_USER_INPUT');
  });
});

describe('defaultRule', () => {
  it('is the rule Hawk adds to a new project: SEEN_MORE 20 per hour, email on, webhook null', () => {
    expect(defaultRule('me@example.com', () => 'id1')).toEqual({
      id: 'id1',
      isEnabled: true,
      whatToReceive: 'SEEN_MORE',
      including: [],
      excluding: [],
      threshold: 20,
      thresholdPeriod: 3_600_000,
      channels: {
        email: { isEnabled: true,
          endpoint: 'me@example.com',
          minPeriod: 60 },
        slack: { isEnabled: false,
          endpoint: '',
          minPeriod: 60 },
        loop: { isEnabled: false,
          endpoint: '',
          minPeriod: 60 },
        telegram: { isEnabled: false,
          endpoint: '',
          minPeriod: 60 },
        webhook: null,
      },
    });
  });
});
