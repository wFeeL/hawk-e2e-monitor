import { SourceMapConsumer } from 'source-map-js';
import type { FakeRelease } from './releases.js';

const MAX_TITLE = 400;
const MAX_STRING = 200;
const MAX_KEYS = 20;
const MAX_ITEMS = 10;
const MAX_DEPTH = 5;
const MAX_FRAMES = 20;
const MAX_SOURCE_LINES = 21;
const MAX_SOURCE_LINE = 140;
const MARGIN = 5;
const FILTERED = '[filtered]';
const SENSITIVE_KEYS = new Set([
  'auth', 'authorization', 'access_token', 'accesstoken', 'token', 'jwt', 'session', 'sessionid', 'session_id',
  'api_key', 'apikey', 'x-api-key', 'x-auth-token', 'bearer', 'client_secret', 'secret', 'credentials',
  'password', 'passwd', 'mysql_pwd', 'oldpassword', 'old-password', 'old_password', 'newpassword', 'new-password', 'new_password',
  'private_key', 'ssh_key', 'card', 'cardnumber', 'card[number]', 'creditcard', 'credit_card', 'pan', 'pin', 'security_code',
  'stripetoken', 'cloudpayments_public_id', 'cloudpayments_secret', 'dsn', 'ssn',
]);
const PAN = /^(?:4[0-9]{12}(?:[0-9]{3})?|[25][1-7][0-9]{14}|6(?:011|5[0-9][0-9])[0-9]{12}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|(?:2131|1800|35\d{3})\d{11})$/u;
const OBJECT_ID = /^[0-9a-f]{24}$/iu;
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/iu;

/** Switches that turn a transformation of Hawk off, so a test can see the failure it would hide. */
export interface GrouperKnobs {
  /** The data filter does not run: sensitive values stay as sent. */
  unmasked?: boolean;
  /** The JavaScript worker does not run: no `beautifiedUserAgent`. */
  noJsWorker?: boolean;
  /** The JavaScript worker does not apply source maps. */
  noSourceMaps?: boolean;
}

type Json = Record<string, unknown>;

/**
 * Cuts a string the way `rightTrim` of Hawk does.
 * @param text String to cut.
 * @param max Longest kept length.
 * @returns The string, or its start and an ellipsis.
 */
function rightTrim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Cuts a value the way the `Sanitizer` of Hawk does.
 * @param data Any value.
 * @param depth Nesting above the value.
 * @returns Sanitized copy.
 */
function sanitize(data: unknown, depth = 0): unknown {
  if (Array.isArray(data)) {
    const items: unknown[] = data.length > MAX_ITEMS ? [...data.slice(0, MAX_ITEMS) as unknown[], `<${String(data.length - MAX_ITEMS)} more items...>`] : data;

    return items.map(item => sanitize(item, depth + 1));
  }

  if (typeof data === 'object' && data !== null) {
    if (depth + 1 > MAX_DEPTH) {
      return '<deep object>';
    }

    const entries = Object.entries(data);
    const result: Json = {};

    for (const [key, value] of entries.slice(0, MAX_KEYS)) {
      result[key] = sanitize(value, depth + 1);
    }

    if (entries.length > MAX_KEYS) {
      result.__meta = `${String(entries.length - MAX_KEYS)} more key(s) skipped`;
    }

    return result;
  }

  return typeof data === 'string' ? rightTrim(data, MAX_STRING) : data;
}

/**
 * Applies the data filter of the grouper to an object, in place.
 * @param field `context` or `addons`.
 */
function filter(field: Json): void {
  for (const [key, value] of Object.entries(field)) {
    if (typeof value === 'object' && value !== null) {
      if (!Array.isArray(value)) {
        filter(value as Json);
      }
    } else if (typeof value === 'string' && !OBJECT_ID.test(value) && !UUID.test(value) && PAN.test(value.replaceAll(/\D/gu, ''))) {
      field[key] = FILTERED;
    } else if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      field[key] = FILTERED;
    }
  }
}

/**
 * Describes a user agent the simple way, with the four strings the JavaScript worker produces.
 * @param userAgent User agent string.
 * @returns Operating system and browser with their versions.
 */
function beautify(userAgent: string): Record<string, string> {
  const browser = /(Chrome|Firefox|Safari)\/([\d.]+)/u.exec(userAgent);
  const os = /\((?:X11; )?([A-Za-z]+)/u.exec(userAgent);

  return { os: os?.[1] ?? 'Unknown',
    osVersion: 'Unknown',
    browser: browser?.[1] ?? 'Unknown',
    browserVersion: browser?.[2] ?? 'Unknown' };
}

/**
 * Maps one frame with the source maps of a release, as `consumeBacktraceFrame` of the JavaScript worker does.
 * @param frame Frame of the event.
 * @param release Saved release with its maps.
 * @returns The frame at its original place with the lines around it, or the frame itself when no map fits.
 */
function mapFrame(frame: Json, release: FakeRelease): Json {
  const file = typeof frame.file === 'string' ? frame.file : '';
  const saved = release.files.find(candidate => file.includes(candidate.originFileName));

  if (saved === undefined || typeof frame.line !== 'number') {
    return frame;
  }

  try {
    const raw = JSON.parse(saved.content) as Record<string, unknown>;
    const consumer = new SourceMapConsumer({ ...raw,
      version: String(raw.version) } as never);
    const original = consumer.originalPositionFor({ line: frame.line,
      column: typeof frame.column === 'number' ? frame.column : 0,
      bias: SourceMapConsumer.LEAST_UPPER_BOUND });

    if (original.source === null || original.line === null) {
      return frame;
    }

    const lines = (consumer.sourceContentFor(original.source, true) ?? '').split(/(?:\r\n|\r|\n)/gu);

    return { ...frame,
      file: original.source,
      line: original.line,
      column: original.column,
      sourceCode: lines.slice(original.line - MARGIN - 1, original.line + MARGIN).map((content, index) => ({ line: Math.max(original.line - MARGIN + index, 1),
        content })) };
  } catch {
    return frame;
  }
}

/**
 * Does to a payload what the JavaScript worker and the grouper of Hawk do before it is stored.
 * @param catcherType Catcher type of the message.
 * @param payload Payload as the collector got it.
 * @param knobs Switches that turn a transformation off.
 * @param releaseOf Finds a saved release of the project by its name, for the source maps.
 * @returns Transformed copy.
 */
export function groom(catcherType: string, payload: Readonly<Json>, knobs: GrouperKnobs = {}, releaseOf?: (name: string) => FakeRelease | undefined): Json {
  const result = structuredClone(payload) as Json;
  const { addons, title } = result;

  if (catcherType === 'errors/javascript' && knobs.noJsWorker !== true && typeof addons === 'object' && addons !== null
    && typeof (addons as Json).userAgent === 'string') {
    (addons as Json).beautifiedUserAgent = beautify((addons as Json).userAgent as string);
  }

  const release = typeof result.release === 'string' ? releaseOf?.(result.release) : undefined;

  if (catcherType === 'errors/javascript' && knobs.noSourceMaps !== true && release !== undefined && Array.isArray(result.backtrace)) {
    result.backtrace = result.backtrace.map((frame: Json) => mapFrame(frame, release));
  }

  if (typeof title === 'string') {
    result.title = rightTrim(title, MAX_TITLE);
  }

  if (Array.isArray(result.backtrace)) {
    result.backtrace = result.backtrace.slice(0, MAX_FRAMES).map((frame: Json) => {
      const { sourceCode } = frame;

      return Array.isArray(sourceCode)
        ? { ...frame,
            sourceCode: sourceCode.slice(0, MAX_SOURCE_LINES).map((line: Json) => ({ ...line,
              content: typeof line.content === 'string' ? rightTrim(line.content, MAX_SOURCE_LINE) : line.content })) }
        : frame;
    });
  }

  for (const name of ['context', 'addons']) {
    if (result[name] !== undefined) {
      result[name] = sanitize(result[name]);

      if (knobs.unmasked !== true && typeof result[name] === 'object' && result[name] !== null) {
        filter(result[name] as Json);
      }
    }
  }

  return result;
}
