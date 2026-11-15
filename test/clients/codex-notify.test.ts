import { afterEach, describe, expect, it } from 'vitest';
import { sendProbe } from '../../src/clients/codex-notify.js';
import { createTelegramClient } from '../../src/clients/telegram.js';
import { isCheckError } from '../../src/errors/taxonomy.js';
import type { CheckError } from '../../src/errors/taxonomy.js';
import { systemClock } from '../../src/time/clock.js';
import { startDeadPort } from '../support/dead-port.js';
import { startEndlessServer } from '../support/endless-server.js';
import { startFakeCodexNotify } from '../support/fake-codex-notify.js';
import type { FakeCodexNotify } from '../support/fake-codex-notify.js';
import { startFakeTelegram } from '../support/fake-telegram.js';
import type { FakeTelegram } from '../support/fake-telegram.js';

const DEPS = { httpTimeoutMs: 300,
  clock: systemClock };
const open: Array<() => Promise<void>> = [];

/** Both fakes of a probe test. */
interface Fakes {
  /** The service that takes the probe. */
  codex: FakeCodexNotify;
  /** The chat the service posts into. */
  telegram: FakeTelegram;
}

/**
 * Starts the fake service and the fake chat behind it.
 * @returns Both fakes.
 */
async function start(): Promise<Fakes> {
  const telegram = await startFakeTelegram();
  const codex = await startFakeCodexNotify({ telegram });

  open.push(async () => codex.close(), async () => telegram.close());

  return { codex,
    telegram };
}

/**
 * Runs a probe that must fail and returns what it threw.
 * @param url Address of the service.
 * @param deps Replacements for the default dependencies.
 * @returns The check error it threw.
 */
async function failure(url: string, deps = DEPS): Promise<CheckError> {
  try {
    await sendProbe(url, 'probe text', deps, AbortSignal.timeout(3000));
  } catch (error) {
    if (isCheckError(error)) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected the probe to fail');
}

afterEach(async () => {
  await Promise.all(open.splice(0).map(async close => close()));
});

describe('sendProbe', () => {
  it('posts the text as a form field without a parse mode, and the message reaches the chat', async () => {
    const { codex, telegram } = await start();

    await sendProbe(codex.url, '[e2e:x] rabc telegram-delivery probe', DEPS, AbortSignal.timeout(2000));

    expect(codex.requests).toEqual([{ path: `/u/${codex.token}`,
      form: { message: '[e2e:x] rabc telegram-delivery probe' } }]);

    const client = createTelegramClient({ apiUrl: telegram.url,
      token: telegram.token,
      httpTimeoutMs: 500,
      clock: systemClock });

    expect((await client.getUpdates(0, 0, AbortSignal.timeout(2000))).messages.map(message => message.text))
      .toEqual(['[e2e:x] rabc telegram-delivery probe']);
  });

  it('404 is telegram_bot_unavailable with the config culprit', async () => {
    const { codex } = await start();
    const error = await failure(`${codex.base}/u/unknownToken1`);

    expect(error.errorClass).toBe('telegram_bot_unavailable');
    expect(error.culprit).toBe('config');
    expect(error.message).toContain('TELEGRAM_NOTIFY_URL');
  });

  it('another status is telegram_bot_unavailable with the network culprit', async () => {
    const { codex } = await start();

    for (const status of [400, 429, 500, 503]) {
      codex.knobs.status = status;

      const error = await failure(codex.url);

      expect(error.errorClass).toBe('telegram_bot_unavailable');
      expect(error.culprit).toBe('network');
      expect(error.facts.status).toBe(status);
    }
  });

  it('a refused connection and a slow answer are telegram_bot_unavailable with the network culprit', async () => {
    const dead = await startDeadPort();

    open.push(async () => new Promise<void>((resolve) => {
      dead.server.close(() => {
        resolve();
      });
    }));

    const refused = await failure(`http://127.0.0.1:${String(dead.port)}/u/secretPathToken9`);

    expect(refused.errorClass).toBe('telegram_bot_unavailable');
    expect(refused.culprit).toBe('network');
    expect(refused.facts.code).toBeDefined();

    // An answer whose body never ends.
    const endless = await startEndlessServer();

    open.push(async () => endless.close());

    const slow = await failure(`${endless.url}/u/secretPathToken9`, { ...DEPS,
      httpTimeoutMs: 100 });

    expect(slow.errorClass).toBe('telegram_bot_unavailable');
    expect(slow.facts.code).toBe('TIMEOUT');
  });

  it('masks the token of the URL in the text, the facts and the cause', async () => {
    const { codex } = await start();
    const dead = await startDeadPort();

    open.push(async () => new Promise<void>((resolve) => {
      dead.server.close(() => {
        resolve();
      });
    }));
    codex.knobs.status = 500;

    const errors = [
      await failure(codex.url),
      await failure(`${codex.base}/u/unknownToken1`),
      await failure(`http://127.0.0.1:${String(dead.port)}/u/${codex.token}`),
    ];

    for (const error of errors) {
      const everything = `${error.message} ${JSON.stringify(error.facts)} ${String(error.cause)}`;

      expect(everything).not.toContain(codex.token);
      expect(everything).not.toContain('unknownToken1');
      expect(error.cause).toBeUndefined();
      expect(error.facts.url).toMatch(/\/u\/\*\*\*$/u);
    }
  });
});
