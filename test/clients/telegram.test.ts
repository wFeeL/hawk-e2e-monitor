import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramClient } from '../../src/clients/telegram.js';
import type { TelegramClient } from '../../src/clients/telegram.js';
import { isCheckError } from '../../src/errors/taxonomy.js';
import type { CheckError } from '../../src/errors/taxonomy.js';
import { systemClock } from '../../src/time/clock.js';
import { startDeadPort } from '../support/dead-port.js';
import { startFakeTelegram } from '../support/fake-telegram.js';
import type { FakeTelegram } from '../support/fake-telegram.js';

const HTTP_TIMEOUT_MS = 300;
const open: Array<() => Promise<void>> = [];

/** A running fake and a client pointed at it. */
interface Started {
  /** The fake Bot API. */
  fake: FakeTelegram;
  /** Client of the fake. */
  client: TelegramClient;
}

/** Parts of the client's dependencies a test replaces. */
interface StartOverrides {
  /** Token the client sends. */
  token?: string;
  /** Address of the Bot API. */
  apiUrl?: string;
  /** Time limit of one request. */
  httpTimeoutMs?: number;
}

/**
 * Starts a fake Bot API and a client for it.
 * @param overrides Parts of the client's dependencies to replace.
 * @returns The fake and the client.
 */
async function start(overrides: StartOverrides = {}): Promise<Started> {
  const fake = await startFakeTelegram();

  open.push(async () => fake.close());

  return { fake,
    client: createTelegramClient({ apiUrl: overrides.apiUrl ?? fake.url,
      token: overrides.token ?? fake.token,
      httpTimeoutMs: overrides.httpTimeoutMs ?? HTTP_TIMEOUT_MS,
      clock: systemClock }) };
}

/**
 * Runs a call that must fail and returns what it threw.
 * @param call Call that is expected to throw.
 * @returns The check error it threw.
 */
async function failure(call: () => Promise<unknown>): Promise<CheckError> {
  try {
    await call();
  } catch (error) {
    if (isCheckError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected the call to fail');
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async close => close()));
});

describe('telegram client answers', () => {
  it('reads the bot with its view of group messages', async () => {
    const { client, fake } = await start();

    expect(await client.getMe(AbortSignal.timeout(2000))).toEqual({ id: fake.botId,
      isBot: true,
      username: 'fake_listener_bot',
      canReadAllGroupMessages: true });

    fake.knobs.privacyOn = true;
    expect((await client.getMe(AbortSignal.timeout(2000))).canReadAllGroupMessages).toBe(false);
  });

  it('reads the webhook address, empty when there is none', async () => {
    const { client, fake } = await start();

    expect(await client.webhookUrl(AbortSignal.timeout(2000))).toBe('');

    fake.knobs.webhookUrl = 'https://hooks.example.com/telegram';
    expect(await client.webhookUrl(AbortSignal.timeout(2000))).toBe('https://hooks.example.com/telegram');
  });

  it('reads the status of a member', async () => {
    const { client, fake } = await start();

    expect(await client.chatMemberStatus('-1001', 42, AbortSignal.timeout(2000))).toBe('administrator');
    expect(fake.requests.at(-1)?.params).toEqual(Object.fromEntries([['chat_id', '-1001'], ['user_id', 42]]));

    fake.knobs.memberStatus = 'member';
    expect(await client.chatMemberStatus('-1001', 42, AbortSignal.timeout(2000))).toBe('member');
  });
});

describe('telegram client getUpdates', () => {
  it('asks for messages only, 100 at a time, and maps what comes back', async () => {
    const { client, fake } = await start();
    const id = fake.push({ chatId: -1002,
      fromUsername: 'codex_bot',
      text: 'title\nbody' });

    const read = await client.getUpdates(0, 0, AbortSignal.timeout(2000));

    expect(fake.requests.at(-1)?.params).toEqual({ offset: 0,
      timeout: 0,
      limit: 100,
      ...Object.fromEntries([['allowed_updates', ['message']]]) });
    expect(read.messages).toEqual([{ updateId: id,
      chatId: -1002,
      chatType: 'supergroup',
      fromUsername: 'codex_bot',
      fromIsBot: true,
      text: 'title\nbody',
      date: 1_700_000_000 + id }]);
    expect(read.nextOffset).toBe(id + 1);
    expect(read.retryAfterS).toBeUndefined();
  });

  it('returns the given offset when there are no updates', async () => {
    const { client } = await start();

    expect((await client.getUpdates(77, 0, AbortSignal.timeout(2000)))).toEqual({ messages: [],
      nextOffset: 77 });
  });

  it('moves the offset forward so a message is not read twice', async () => {
    const { client, fake } = await start();

    fake.push({ text: 'first' });
    fake.push({ text: 'second' });

    const one = await client.getUpdates(0, 0, AbortSignal.timeout(2000));

    expect(one.messages.map(message => message.text)).toEqual(['first', 'second']);

    const two = await client.getUpdates(one.nextOffset, 0, AbortSignal.timeout(2000));

    expect(two.messages).toEqual([]);
    expect(two.nextOffset).toBe(one.nextOffset);

    fake.push({ text: 'third' });

    const three = await client.getUpdates(two.nextOffset, 0, AbortSignal.timeout(2000));

    expect(three.messages.map(message => message.text)).toEqual(['third']);
  });

  it('drains the old updates with offset -1 and keeps the last id plus one', async () => {
    const { client, fake } = await start();

    fake.push({ text: 'old' });

    const lastId = fake.push({ text: 'older' });
    const drained = await client.getUpdates(-1, 0, AbortSignal.timeout(2000));

    expect(drained.nextOffset).toBe(lastId + 1);
    expect((await client.getUpdates(drained.nextOffset, 0, AbortSignal.timeout(2000))).messages).toEqual([]);
  });

  it('moves the offset past an update that is not a message', async () => {
    const { client, fake } = await start();
    const id = fake.pushOther();
    const read = await client.getUpdates(0, 0, AbortSignal.timeout(2000));

    expect(read.messages).toEqual([]);
    expect(read.nextOffset).toBe(id + 1);
  });

  it('long poll returns as soon as a message is pushed', async () => {
    const { client, fake } = await start();
    const startedAt = performance.now();
    const waiting = client.getUpdates(0, 10, AbortSignal.timeout(5000));

    setTimeout(() => {
      fake.push({ text: 'late arrival' });
    }, 50);

    const read = await waiting;

    expect(read.messages.map(message => message.text)).toEqual(['late arrival']);
    expect(performance.now() - startedAt).toBeLessThan(2000);
  });

  it('lets the long poll last longer than the HTTP timeout, by the poll time', async () => {
    const { client, fake } = await start({ httpTimeoutMs: 100 });

    fake.knobs.delayMs = 250;
    fake.knobs.holdMs = 0;

    // The request time is timeoutS * 1000 + httpTimeoutMs, so 250 ms is within 1 s + 100 ms.
    expect((await client.getUpdates(0, 1, AbortSignal.timeout(3000))).messages).toEqual([]);

    const error = await failure(async () => client.getMe(AbortSignal.timeout(3000)));

    expect(error.errorClass).toBe('telegram_api_unavailable');
    expect(error.facts.code).toBe('TIMEOUT');
  });

  it('a 429 gives retryAfterS and does not throw', async () => {
    const { client, fake } = await start();

    fake.knobs.status = { getUpdates: 429 };
    fake.knobs.retryAfter = 7;

    expect(await client.getUpdates(5, 0, AbortSignal.timeout(2000))).toEqual({ messages: [],
      nextOffset: 5,
      retryAfterS: 7 });
  });
});

describe('telegram client failures', () => {
  it('401 is telegram_auth_failed', async () => {
    const { client } = await start({ token: '123:wrong-token-with-enough-characters-in-it' });
    const error = await failure(async () => client.getMe(AbortSignal.timeout(2000)));

    expect(error.errorClass).toBe('telegram_auth_failed');
    expect(error.culprit).toBe('config');
  });

  it('409 is telegram_conflict in every method, getUpdates included', async () => {
    const { client, fake } = await start();

    fake.knobs.status = { getUpdates: 409,
      getWebhookInfo: 409 };

    for (const call of [
      async () => client.getUpdates(0, 0, AbortSignal.timeout(2000)),
      async () => client.webhookUrl(AbortSignal.timeout(2000)),
    ]) {
      const error = await failure(call);

      expect(error.errorClass).toBe('telegram_conflict');
      expect(error.culprit).toBe('config');
    }
  });

  it('5xx, other 4xx and a 429 outside getUpdates are telegram_api_unavailable', async () => {
    const { client, fake } = await start();

    for (const status of [500, 502, 400, 403, 429]) {
      fake.knobs.status = { getMe: status };

      const error = await failure(async () => client.getMe(AbortSignal.timeout(2000)));

      expect(error.errorClass).toBe('telegram_api_unavailable');
      expect(error.culprit).toBe('network');
      expect(error.facts.status).toBe(status);
    }
  });

  it('keeps the description of an other 4xx in the text', async () => {
    const { client, fake } = await start();

    fake.knobs.status = { getMe: 400 };

    expect((await failure(async () => client.getMe(AbortSignal.timeout(2000)))).message).toContain('fake error 400');
  });

  it('a 400 or a 403 of getChatMember is telegram_bot_misconfigured with the description and TELEGRAM_CHAT_ID, and no token', async () => {
    const { client, fake } = await start();

    for (const status of [400, 403]) {
      fake.knobs.status = { getChatMember: status };

      const error = await failure(async () => client.chatMemberStatus('-1', 1, AbortSignal.timeout(2000)));

      expect(error.errorClass).toBe('telegram_bot_misconfigured');
      expect(error.culprit).toBe('config');
      expect(error.message).toContain(`fake error ${String(status)}`);
      expect(error.message).toContain('TELEGRAM_CHAT_ID');
      expect(`${error.message} ${JSON.stringify(error.facts)}`).not.toContain(fake.token);
    }
  });

  it('other failures of getChatMember stay telegram_api_unavailable', async () => {
    const { client, fake } = await start();

    for (const status of [404, 429, 500]) {
      fake.knobs.status = { getChatMember: status };

      expect((await failure(async () => client.chatMemberStatus('-1', 1, AbortSignal.timeout(2000)))).errorClass).toBe('telegram_api_unavailable');
    }

    fake.knobs.status = { getChatMember: 401 };
    expect((await failure(async () => client.chatMemberStatus('-1', 1, AbortSignal.timeout(2000)))).errorClass).toBe('telegram_auth_failed');
  });

  it('an answer that is not JSON, or not a Bot API answer, is telegram_api_unavailable', async () => {
    const { client, fake } = await start();

    fake.knobs.rawBody = { getMe: '<html>bad gateway</html>',
      getWebhookInfo: '{"ok":true}' };

    expect((await failure(async () => client.getMe(AbortSignal.timeout(2000)))).errorClass).toBe('telegram_api_unavailable');
    expect((await failure(async () => client.webhookUrl(AbortSignal.timeout(2000)))).errorClass).toBe('telegram_api_unavailable');
  });

  it('a refused connection is telegram_api_unavailable with the code', async () => {
    const dead = await startDeadPort();

    open.push(async () => new Promise<void>((resolve) => {
      dead.server.close(() => {
        resolve();
      });
    }));

    const { client } = await start({ apiUrl: `http://127.0.0.1:${String(dead.port)}` });
    const error = await failure(async () => client.getMe(AbortSignal.timeout(2000)));

    expect(error.errorClass).toBe('telegram_api_unavailable');
    expect(error.facts.code).toBeDefined();
  });

  it('a slow answer is telegram_api_unavailable with TIMEOUT', async () => {
    const { client, fake } = await start({ httpTimeoutMs: 50 });

    fake.knobs.delayMs = 300;

    const error = await failure(async () => client.webhookUrl(AbortSignal.timeout(3000)));

    expect(error.errorClass).toBe('telegram_api_unavailable');
    expect(error.facts.code).toBe('TIMEOUT');
  });

  it('the token is in no error: not in the text, the facts or the cause', async () => {
    const { client, fake } = await start();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['401', async () => createTelegramClient({ apiUrl: fake.url,
        token: `${String(fake.botId)}:wrong-token-with-enough-characters-in-it`,
        httpTimeoutMs: HTTP_TIMEOUT_MS,
        clock: systemClock }).getMe(AbortSignal.timeout(2000))],
      ['409', async () => {
        fake.knobs.status = { getUpdates: 409 };

        return client.getUpdates(0, 0, AbortSignal.timeout(2000));
      }],
      ['500', async () => {
        fake.knobs.status = { getMe: 500 };

        return client.getMe(AbortSignal.timeout(2000));
      }],
      ['not json', async () => {
        fake.knobs.status = {};
        fake.knobs.rawBody = { getMe: 'not json' };

        return client.getMe(AbortSignal.timeout(2000));
      }],
      ['timeout', async () => {
        fake.knobs.rawBody = {};
        fake.knobs.delayMs = 1000;

        return createTelegramClient({ apiUrl: fake.url,
          token: fake.token,
          httpTimeoutMs: 40,
          clock: systemClock }).getMe(AbortSignal.timeout(3000));
      }],
    ];

    for (const [name, call] of cases) {
      const error = await failure(call);
      const everything = `${error.message} ${JSON.stringify(error.facts)} ${String(error.cause)}`;

      expect(everything, name).not.toContain(fake.token);
      expect(everything, name).not.toContain('AAFake');
      expect(error.cause, name).toBeUndefined();
    }
  });

  it('writes the URL of the facts as <apiUrl>/bot***/<method>', async () => {
    const { client, fake } = await start();

    fake.knobs.status = { getWebhookInfo: 500 };

    const error = await failure(async () => client.webhookUrl(AbortSignal.timeout(2000)));

    expect(error.facts.url).toBe(`${fake.url}/bot***/getWebhookInfo`);
  });
});
