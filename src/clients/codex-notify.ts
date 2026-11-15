import { CheckError } from '../errors/taxonomy.js';
import { NetworkError, httpRequest } from '../net/http.js';
import { HttpStatus } from '../net/http-status.js';
import type { Clock } from '../time/clock.js';

const FORM_HEADERS = Object.fromEntries([['content-type', 'application/x-www-form-urlencoded']]);
const MASKED_PATH = '/u/***';
const FALLBACK_URL = 'the notify URL';

/** What `sendProbe` needs besides the address and the text. */
export interface ProbeDeps {
  /** Time limit of the request. */
  httpTimeoutMs: number;
  /** Clock, kept for the signature shared with the other clients. */
  clock: Clock;
}

/**
 * Writes the address of the service without the token of the chat.
 * @param url Notify URL, `<origin>/u/<token>`.
 * @returns `<origin>/u/***`, or a fixed phrase when the address does not parse.
 */
function maskedUrl(url: string): string {
  return URL.canParse(url) ? `${new URL(url).origin}${MASKED_PATH}` : FALLBACK_URL;
}

/**
 * Sends a probe text through @codex_bot: a form POST with `message` and no parse mode, so the text arrives as it is.
 * @param url Notify URL; it carries the chat token, so it never goes into an error.
 * @param text Message to send, which the test chat shows to the bot reader.
 * @param deps Time limit and clock.
 * @param signal Aborts the request when the run is cut.
 * @returns Resolves when the service answered 2xx.
 * @throws CheckError `telegram_bot_unavailable`: with the config culprit for a 404, which means the token is unknown, and with the network culprit for any other failure.
 */
export async function sendProbe(url: string, text: string, deps: ProbeDeps, signal: AbortSignal): Promise<void> {
  const masked = maskedUrl(url);
  let response;

  try {
    response = await httpRequest({ url,
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams([['message', text]]).toString(),
      timeoutMs: deps.httpTimeoutMs,
      signal }, 'notify');
  } catch (error) {
    if (!(error instanceof NetworkError)) {
      throw error;
    }

    // The cause is dropped on purpose: it may carry the address with the token.
    throw new CheckError('telegram_bot_unavailable', { url: masked,
      code: error.failure.code });
  }

  if (response.status >= HttpStatus.ok && response.status < HttpStatus.multipleChoices) {
    return;
  }

  throw new CheckError('telegram_bot_unavailable', { url: masked,
    status: response.status },
  response.status === HttpStatus.notFound ? { culprit: 'config' } : {});
}
