import { CheckError } from '../errors/taxonomy.js';
import type { ErrorClass, MessageFacts } from '../errors/taxonomy.js';
import { NetworkError, httpRequest } from '../net/http.js';
import type { HttpResponse } from '../net/http.js';
import { HttpStatus } from '../net/http-status.js';
import type { Clock } from '../time/clock.js';
import { MS_PER_SECOND } from '../time/units.js';

// 4 MiB, the cap of the other clients' bodies.
const MAX_BODY_BYTES = 4_194_304;
const UPDATES_LIMIT = 100;
const MAX_DESCRIPTION_CHARS = 200;
const JSON_HEADERS = Object.fromEntries([['content-type', 'application/json']]);

/** The bot as `getMe` describes it. */
export interface TelegramUser {
  /** Id of the user. */
  id: number;
  /** Whether it is a bot. */
  isBot: boolean;
  /** Username without `@`. */
  username?: string;
  /** Whether the bot sees every message of a group, which needs the privacy mode off. */
  canReadAllGroupMessages?: boolean;
}

/** A message of an update. */
export interface TelegramMessage {
  /** Id of the update that carried it. */
  updateId: number;
  /** Id of the chat. */
  chatId: number;
  /** Type of the chat, such as `supergroup`. */
  chatType: string;
  /** Username of the sender, when it has one. */
  fromUsername?: string;
  /** Whether the sender is a bot. */
  fromIsBot: boolean;
  /** Text of the message; empty for a message without text. */
  text: string;
  /** Unix time of the message, seconds. */
  date: number;
}

/** What one `getUpdates` call returned. */
export interface TelegramUpdates {
  /** Messages of the updates, in order. */
  messages: TelegramMessage[];
  /** Offset for the next call: the last update id plus one, or the given offset when nothing came. */
  nextOffset: number;
  /** Seconds the API asked to wait after a 429. */
  retryAfterS?: number;
}

/** Talks to the Telegram Bot API as one bot. */
export interface TelegramClient {
  /**
   * Reads the bot.
   * @param signal Aborts the call.
   * @returns The bot.
   * @throws CheckError of a Telegram class.
   */
  getMe(signal: AbortSignal): Promise<TelegramUser>;
  /**
   * Reads the address of the webhook of the bot.
   * @param signal Aborts the call.
   * @returns The address, empty when none is set.
   * @throws CheckError of a Telegram class.
   */
  webhookUrl(signal: AbortSignal): Promise<string>;
  /**
   * Reads the status of a user in a chat.
   * @param chatId Id of the chat, as text.
   * @param userId Telegram id of the user whose status is read.
   * @param signal Aborts the call.
   * @returns Status, such as `administrator`.
   * @throws CheckError of a Telegram class.
   */
  chatMemberStatus(chatId: string, userId: number, signal: AbortSignal): Promise<string>;
  /**
   * Reads the messages after an offset, waiting up to `timeoutS` for the first one.
   * @param offset First update id wanted; a negative value reads the last update.
   * @param timeoutS Long-poll time in seconds.
   * @param signal Aborts the call.
   * @returns Messages, the next offset and the pause of a 429.
   * @throws CheckError of a Telegram class; a 429 is returned, not thrown.
   */
  getUpdates(offset: number, timeoutS: number, signal: AbortSignal): Promise<TelegramUpdates>;
}

/** What the client needs. */
export interface TelegramClientDeps {
  /** Origin of the Bot API. */
  apiUrl: string;
  /** Bot token; it never goes into an error. */
  token: string;
  /** Time limit of one request, and the allowance added to a long poll. */
  httpTimeoutMs: number;
  /** Clock, kept for the signature shared with the other clients. */
  clock: Clock;
}

/** A JSON object whose keys are the API's own. */
type Json = Record<string, unknown>;

/**
 * Narrows a value to a JSON object.
 * @param value Anything parsed from JSON.
 * @returns The object, or undefined for anything else.
 */
function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined;
}

/**
 * Parses an answer body.
 * @param text Body text.
 * @returns The answer, or undefined when the body is not a JSON object.
 */
function parseAnswer(text: string): Json | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Builds a failure of a class with facts that carry no token.
 * @param errorClass Taxonomy class.
 * @param facts Facts of the text.
 * @returns The error; it has no cause, because a cause may print the address.
 */
function failure(errorClass: ErrorClass, facts: MessageFacts): CheckError {
  return new CheckError(errorClass, facts);
}

/**
 * Creates the client.
 * @param deps Address of the Bot API, bot token and time limits.
 * @returns A client that talks to one bot through the Bot API.
 */
export function createTelegramClient(deps: TelegramClientDeps): TelegramClient {
  const { token, httpTimeoutMs } = deps;
  const hide = (text: string): string => text.split(token).join('***');

  /**
   * Calls one method and checks the answer.
   * @param method Bot API method.
   * @param timeoutMs Time limit of the request.
   * @param signal Aborts the call.
   * @param params Parameters; a call with a body is a POST.
   * @param throttled Called with the answer of a 429 instead of throwing; the call returns what it returns.
   * @returns The `result` of the answer, or what `throttled` returned.
   */
  const call = async (method: string, timeoutMs: number, signal: AbortSignal, params: Record<string, unknown>, throttled?: (seconds: number) => unknown): Promise<unknown> => {
    const masked = `${deps.apiUrl}/bot***/${method}`;
    const facts: MessageFacts = { url: masked };
    let response: HttpResponse;

    try {
      response = await httpRequest({ url: `${deps.apiUrl}/bot${token}/${method}`,
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(params),
        timeoutMs,
        maxBytes: MAX_BODY_BYTES,
        signal }, 'telegram');
    } catch (error) {
      if (!(error instanceof NetworkError)) {
        throw error;
      }

      // The cause is dropped on purpose: it may carry the address with the token.
      throw failure('telegram_api_unavailable', { ...facts,
        code: error.failure.code });
    }

    const answer = parseAnswer(response.text);
    const status = response.status === HttpStatus.ok && typeof answer?.error_code === 'number' ? answer.error_code : response.status;
    const description = typeof answer?.description === 'string' ? hide(answer.description).slice(0, MAX_DESCRIPTION_CHARS) : undefined;
    const detail = description === undefined ? {} : { detail: description };

    if (status === HttpStatus.ok && answer?.ok === true && answer.result !== undefined) {
      return answer.result;
    }

    if (status === HttpStatus.unauthorized) {
      throw failure('telegram_auth_failed', { ...facts,
        status,
        ...detail });
    }

    if (status === HttpStatus.conflict) {
      throw failure('telegram_conflict', { ...facts,
        status,
        ...detail });
    }

    const retryAfter = asObject(answer?.parameters)?.retry_after;

    if (status === HttpStatus.tooManyRequests && throttled !== undefined) {
      return throttled(typeof retryAfter === 'number' ? retryAfter : 1);
    }

    throw failure('telegram_api_unavailable', { ...facts,
      status,
      ...answer === undefined ? { detail: 'the answer is not a Bot API answer' } : detail });
  };

  const getMe: TelegramClient['getMe'] = async (signal) => {
    const result = asObject(await call('getMe', httpTimeoutMs, signal, {})) ?? {};

    if (typeof result.id !== 'number') {
      throw failure('telegram_api_unavailable', { url: `${deps.apiUrl}/bot***/getMe`,
        detail: 'the answer has no bot id' });
    }

    return { id: result.id,
      isBot: result.is_bot === true,
      ...typeof result.username === 'string' ? { username: result.username } : {},
      ...typeof result.can_read_all_group_messages === 'boolean' ? { canReadAllGroupMessages: result.can_read_all_group_messages } : {} };
  };

  const webhookUrl: TelegramClient['webhookUrl'] = async (signal) => {
    const result = asObject(await call('getWebhookInfo', httpTimeoutMs, signal, {})) ?? {};

    if (typeof result.url !== 'string') {
      throw failure('telegram_api_unavailable', { url: `${deps.apiUrl}/bot***/getWebhookInfo`,
        detail: 'the answer has no webhook address' });
    }

    return result.url;
  };

  const chatMemberStatus: TelegramClient['chatMemberStatus'] = async (chatId, userId, signal) => {
    const result = asObject(await call('getChatMember', httpTimeoutMs, signal, Object.fromEntries([['chat_id', chatId], ['user_id', userId]]) as Json)) ?? {};

    if (typeof result.status !== 'string') {
      throw failure('telegram_api_unavailable', { url: `${deps.apiUrl}/bot***/getChatMember`,
        detail: 'the answer has no member status' });
    }

    return result.status;
  };

  const getUpdates: TelegramClient['getUpdates'] = async (offset, timeoutS, signal) => {
    let retryAfterS: number | undefined;
    const throttled = (seconds: number): unknown[] => {
      retryAfterS = seconds;

      return [];
    };
    const result = await call('getUpdates', timeoutS * MS_PER_SECOND + httpTimeoutMs, signal, { offset,
      timeout: timeoutS,
      limit: UPDATES_LIMIT,
      ...Object.fromEntries([['allowed_updates', ['message']]]) }, throttled);

    if (!Array.isArray(result)) {
      throw failure('telegram_api_unavailable', { url: `${deps.apiUrl}/bot***/getUpdates`,
        detail: 'the answer is not a list of updates' });
    }

    const messages: TelegramMessage[] = [];
    let nextOffset = offset;

    for (const raw of result) {
      const update = asObject(raw);
      const id = update?.update_id;

      if (update === undefined || typeof id !== 'number') {
        continue;
      }

      nextOffset = Math.max(nextOffset, id + 1);

      const message = asObject(update.message);
      const chat = asObject(message?.chat);
      const from = asObject(message?.from);

      if (message === undefined || typeof chat?.id !== 'number') {
        continue;
      }

      messages.push({ updateId: id,
        chatId: chat.id,
        chatType: typeof chat.type === 'string' ? chat.type : '',
        ...typeof from?.username === 'string' ? { fromUsername: from.username } : {},
        fromIsBot: from?.is_bot === true,
        text: typeof message.text === 'string' ? message.text : '',
        date: typeof message.date === 'number' ? message.date : 0 });
    }

    return { messages,
      nextOffset,
      ...retryAfterS === undefined ? {} : { retryAfterS } };
  };

  return { getMe,
    webhookUrl,
    chatMemberStatus,
    getUpdates };
}
