import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramClient } from '../../src/clients/telegram.js';
import type { TelegramClient } from '../../src/clients/telegram.js';
import { systemClock } from '../../src/time/clock.js';
import { startFakeCodexNotify } from './fake-codex-notify.js';
import type { FakeCodexNotify } from './fake-codex-notify.js';
import { startFakeTelegram } from './fake-telegram.js';

const open: Array<() => Promise<void>> = [];

/** The service under test and a client that reads its chat. */
interface Started {
  /** The fake notify service. */
  codex: FakeCodexNotify;
  /** Client of the fake Telegram behind it. */
  client: TelegramClient;
}

/**
 * Starts both fakes and a Telegram client for the chat.
 * @returns The service and a client that reads the chat.
 */
async function start(): Promise<Started> {
  const telegram = await startFakeTelegram();
  const codex = await startFakeCodexNotify({ telegram });

  open.push(async () => codex.close(), async () => telegram.close());

  return { codex,
    client: createTelegramClient({ apiUrl: telegram.url,
      token: telegram.token,
      httpTimeoutMs: 500,
      clock: systemClock }) };
}

/**
 * Posts a form to the fake service.
 * @param url Address to post to.
 * @param fields Form fields.
 * @returns The status of the answer.
 */
async function post(url: string, fields: Record<string, string>): Promise<number> {
  const response = await fetch(url, { method: 'POST',
    headers: Object.fromEntries([['content-type', 'application/x-www-form-urlencoded']]),
    body: new URLSearchParams(fields).toString() });

  await response.body?.cancel();

  return response.status;
}

/**
 * Reads the texts in the chat.
 * @param client Client of the fake Telegram.
 * @returns Texts in order.
 */
async function texts(client: TelegramClient): Promise<string[]> {
  return (await client.getUpdates(0, 0, AbortSignal.timeout(2000))).messages.map(message => message.text);
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async close => close()));
});

describe('fake codex notify', () => {
  it('puts the text of a POST into the chat as a message from the bot', async () => {
    const { codex, client } = await start();

    expect(await post(codex.url, { message: 'hello' })).toBe(200);

    const { messages } = await client.getUpdates(0, 0, AbortSignal.timeout(2000));

    expect(messages).toMatchObject([{ fromUsername: 'codex_bot',
      fromIsBot: true,
      text: 'hello' }]);
  });

  it('removes Markdown escapes only when the parse mode is Markdown', async () => {
    const { codex, client } = await start();

    await post(codex.url, { message: String.raw`\[e2e:x] a\_b`,
      ...Object.fromEntries([['parse_mode', 'Markdown']]) });
    await post(codex.url, { message: String.raw`\[plain]` });

    expect(await texts(client)).toEqual(['[e2e:x] a_b', String.raw`\[plain]`]);
  });

  it('answers 404 for an unknown token and sends nothing', async () => {
    const { codex, client } = await start();

    expect(await post(`${codex.base}/u/unknown`, { message: 'x' })).toBe(404);
    expect(await texts(client)).toEqual([]);
  });

  it('answers with the forced status or drops the message', async () => {
    const { codex, client } = await start();

    codex.knobs.status = 503;
    expect(await post(codex.url, { message: 'a' })).toBe(503);

    codex.knobs.status = undefined;
    codex.knobs.drop = true;
    expect(await post(codex.url, { message: 'b' })).toBe(200);
    expect(await texts(client)).toEqual([]);
    expect(codex.requests).toHaveLength(2);
  });
});
