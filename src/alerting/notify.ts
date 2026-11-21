import { CheckError } from '../errors/taxonomy.js';
import type { Culprit } from '../errors/taxonomy.js';
import type { NetworkFailure } from '../net/classify.js';
import { NetworkError, httpRequest } from '../net/http.js';
import type { Clock } from '../time/clock.js';
import { HttpStatus } from '../net/http-status.js';

const FORM_HEADERS = Object.fromEntries([['content-type', 'application/x-www-form-urlencoded']]);
const OK_MARK = 'OK!';
const MAX_BODY_CHARS = 200;

/** A network failure that may name the side to blame. */
interface BlamedFailure extends NetworkFailure {
  /** Culprit given by the classifier, when it gives one. */
  culprit?: Culprit;
}

/** What `sendNotify` needs besides the address and the text. */
export interface NotifyDeps {
  /** Time limit of the request. */
  httpTimeoutMs: number;
  /** Clock, kept for the signature shared with the other clients. */
  clock: Clock;
}

/**
 * Sends a text to codex.bot: a form POST with `message`, `parse_mode=HTML` and `disable_web_page_preview=true`.
 * The bot accepted the text when it answered 200 and the body contains `OK!`.
 * @param url Notify URL; it carries the chat token, so it never goes into an error.
 * @param text HTML text, at most 3500 characters.
 * @param deps Time limit and clock.
 * @param signal Cancels the request.
 * @returns Resolves when the bot accepted the text.
 * @throws CheckError `alert_rejected` for an answer that is not acceptance, `network_error` for a 5xx or when there was no answer.
 */
export async function sendNotify(url: string, text: string, deps: NotifyDeps, signal: AbortSignal): Promise<void> {
  const form = new URLSearchParams([['message', text], ['parse_mode', 'HTML'], ['disable_web_page_preview', 'true']]);
  let response;

  try {
    response = await httpRequest({ url,
      method: 'POST',
      headers: FORM_HEADERS,
      body: form.toString(),
      timeoutMs: deps.httpTimeoutMs,
      signal }, 'notify');
  } catch (error) {
    if (!(error instanceof NetworkError)) {
      throw error;
    }

    const host = URL.canParse(url) ? new URL(url).hostname : 'the notify URL';
    // The classifier names the culprit for a target that is not Hawk; until it does, the class decides.
    const failure: BlamedFailure = error.failure;

    // The cause is dropped on purpose: it may carry the address with the token.
    throw new CheckError(failure.errorClass, { code: failure.code,
      host }, { message: `codex.bot is not reachable at ${host}: ${failure.code}`,
      ...failure.culprit === undefined ? {} : { culprit: failure.culprit } });
  }

  if (response.status >= HttpStatus.internalServerError) {
    const host = URL.canParse(url) ? new URL(url).hostname : 'the notify URL';

    throw new CheckError('network_error', { status: response.status,
      host }, { message: `codex.bot answered ${String(response.status)} at ${host}` });
  }

  if (response.status !== HttpStatus.ok || !response.text.includes(OK_MARK)) {
    throw new CheckError('alert_rejected', { status: response.status,
      detail: response.text.slice(0, MAX_BODY_CHARS) });
  }
}
