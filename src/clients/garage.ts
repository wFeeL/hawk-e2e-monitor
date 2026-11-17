import { CheckError } from '../errors/taxonomy.js';
import type { MessageFacts } from '../errors/taxonomy.js';
import { HttpStatus } from '../net/http-status.js';
import { NetworkError, networkFailureToCheckError, requestWithRetry } from '../net/http.js';
import type { HttpRequest, HttpResponse } from '../net/http.js';
import type { RetryPolicy } from '../net/retry.js';
import type { Clock } from '../time/clock.js';

const INDEX_MAX_BYTES = 262_144;
const BUNDLE_RANGE = 'bytes=0-1023';
const BUNDLE_MAX_BYTES = 1024;
const SCRIPT_TAG = /<script\b([^>]*)>/giu;
const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/gu;
const WHAT_INDEX = 'the index page';
const WHAT_BUNDLE = 'the script bundle';

/** What `checkGarage` needs. */
export interface GarageDeps {
  /** Time limit of one request. */
  httpTimeoutMs: number;
  /** Time source for the times and the pauses between attempts. */
  clock: Clock;
  /** Attempts and pauses for a 5xx answer or a network failure. */
  retry: RetryPolicy;
}

/** What `checkGarage` found. */
export interface GarageCheck {
  /** Time to get the index page. */
  indexMs: number;
  /** Path of the script bundle that was checked. */
  bundle: string;
  /** Time to get the start of the bundle. */
  bundleMs: number;
}

/**
 * Reads the attributes of a tag.
 * @param text Text between `<script` and `>`.
 * @returns Attribute values by lowercase name; an attribute without a value is an empty string.
 */
function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>();

  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1]?.toLowerCase();

    if (name !== undefined && !attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
  }

  return attributes;
}

/**
 * Finds the first module script of the page that Garage serves itself.
 * @param html Index page.
 * @param origin Origin of Garage.
 * @returns Address of the script, or undefined when no module script has a source of the same origin.
 */
function moduleScriptOf(html: string, origin: string): URL | undefined {
  for (const tag of html.matchAll(SCRIPT_TAG)) {
    const attributes = attributesOf(tag[1] ?? '');
    const source = attributes.get('src');

    if (attributes.get('type')?.toLowerCase() === 'module' && source !== undefined && source !== '') {
      const address = URL.canParse(source, `${origin}/`) ? new URL(source, `${origin}/`) : undefined;

      if (address?.origin === origin) {
        return address;
      }
    }
  }

  return undefined;
}

/**
 * Builds the failure of a page Garage did not serve.
 * @param origin Origin of Garage.
 * @param what Page that was wanted.
 * @param reason Why it is not good, or a status.
 * @returns Error of class `garage_unavailable`.
 */
function notServed(origin: string, what: string, reason: number | string): CheckError {
  const facts: MessageFacts = { url: origin,
    detail: what,
    ...typeof reason === 'number' ? { status: reason } : { cause: reason } };

  return new CheckError('garage_unavailable', facts);
}

/**
 * Gets a page with retries, turning a network failure into a taxonomy error.
 * @param request Request to send.
 * @param deps Retry policy and clock.
 * @param origin Origin of Garage, for the error.
 * @param what Page that is wanted, for the error.
 * @returns The answer; its status is left to the caller.
 */
async function fetchPage(request: HttpRequest, deps: GarageDeps, origin: string, what: string): Promise<HttpResponse> {
  try {
    const { response } = await requestWithRetry(request, 'garage', { attempts: deps.retry.attempts,
      delaysMs: deps.retry.delaysMs,
      clock: deps.clock,
      retryStatus: status => status >= HttpStatus.internalServerError,
      retryNetwork: () => true });

    return response;
  } catch (error) {
    if (error instanceof NetworkError) {
      throw networkFailureToCheckError(error, { url: origin,
        detail: what });
    }

    throw error;
  }
}

/**
 * Checks that Garage serves its index page and the start of the script bundle the page names.
 * Garage answers the index page for every path it does not know, so the bundle must really be JavaScript.
 * @param origin Origin of Garage without a trailing slash.
 * @param deps Time limit of a request, clock and retry policy.
 * @param signal Cancels the requests.
 * @returns The bundle that was checked and the times of the two requests.
 * @throws CheckError `garage_unavailable`, or a network class of the taxonomy for DNS and TLS failures.
 */
export async function checkGarage(origin: string, deps: GarageDeps, signal: AbortSignal): Promise<GarageCheck> {
  const indexStarted = deps.clock.monotonicMs();
  const index = await fetchPage({ url: `${origin}/`,
    method: 'GET',
    timeoutMs: deps.httpTimeoutMs,
    maxBytes: INDEX_MAX_BYTES,
    signal }, deps, origin, WHAT_INDEX);
  const indexMs = deps.clock.monotonicMs() - indexStarted;

  if (index.status !== HttpStatus.ok) {
    throw notServed(origin, WHAT_INDEX, index.status);
  }

  if (!index.contentType.toLowerCase().includes('text/html')) {
    throw notServed(origin, WHAT_INDEX, `content-type is ${index.contentType === '' ? 'missing' : index.contentType}`);
  }

  const script = moduleScriptOf(index.text, origin);

  if (script === undefined) {
    throw notServed(origin, WHAT_INDEX, 'index.html has no module script');
  }

  const bundleStarted = deps.clock.monotonicMs();
  const bundle = await fetchPage({ url: script.href,
    method: 'GET',
    headers: Object.fromEntries([['range', BUNDLE_RANGE]]),
    timeoutMs: deps.httpTimeoutMs,
    maxBytes: BUNDLE_MAX_BYTES,
    signal }, deps, origin, WHAT_BUNDLE);
  const bundleMs = deps.clock.monotonicMs() - bundleStarted;

  if (bundle.status !== HttpStatus.ok && bundle.status !== HttpStatus.partialContent) {
    throw notServed(origin, WHAT_BUNDLE, bundle.status);
  }

  if (!bundle.contentType.toLowerCase().includes('javascript')) {
    throw notServed(origin, WHAT_BUNDLE, `content-type is ${bundle.contentType === '' ? 'missing' : bundle.contentType}`);
  }

  const first = bundle.text.trimStart()[0];

  if (first === undefined) {
    throw notServed(origin, WHAT_BUNDLE, 'the body is empty');
  }

  if (first === '<') {
    throw notServed(origin, WHAT_BUNDLE, 'the body starts with "<"');
  }

  return { indexMs,
    bundle: script.pathname,
    bundleMs };
}
