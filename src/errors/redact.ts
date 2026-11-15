const MIN_SECRET_LENGTH = 4;
const MASK = '***';

/** Start of the collector's message for an invalid integration token; the secret follows it. */
export const TOKEN_INVALID_PREFIX = 'Integration token invalid';

/** Replaces secrets in a text. */
export type Redactor = (text: string) => string;

/**
 * Builds a redactor that masks every occurrence of each secret.
 * The caller passes each secret in every form it can appear in, such as
 * the `secret` with dashes and the `tokenKey` without them.
 * @param secrets Secret values; those shorter than 4 characters are ignored.
 * @returns Function that replaces secrets with `***`.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const sorted = secrets
    .filter(secret => secret.length >= MIN_SECRET_LENGTH)
    .toSorted((left, right) => right.length - left.length);

  return (text) => {
    let result = text;

    for (const secret of sorted) {
      result = result.split(secret).join(MASK);
    }

    return result;
  };
}

/** A redactor that learns secrets while the process runs. */
export interface MutableRedactor {
  /** Masks every secret known at the moment of the call. */
  redact: Redactor;
  /** Adds a secret, such as a public address known only after startup; one shorter than 4 characters is ignored. */
  add: (secret: string) => void;
}

/**
 * Builds a redactor whose secret list grows after creation.
 * @param secrets Secrets known at the start.
 * @returns The redactor and the function that adds a secret.
 */
export function createMutableRedactor(secrets: readonly string[]): MutableRedactor {
  const known = new Set(secrets);
  let current = createRedactor([...known]);

  const add: MutableRedactor['add'] = (secret) => {
    if (secret.length < MIN_SECRET_LENGTH || known.has(secret)) {
      return;
    }

    known.add(secret);
    current = createRedactor([...known]);
  };

  return {
    redact: text => current(text),
    add,
  };
}

/**
 * Tells whether a value is a plain object or an array.
 * @param value Anything.
 * @returns True when it is safe to rebuild.
 */
function isPlain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;

  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

/**
 * Masks string values in nested objects and arrays. Keys and non-plain
 * objects (dates, errors) are left as they are.
 * @param value Data to clean.
 * @param redact Redactor for strings.
 * @returns A copy with masked strings.
 */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === 'string') {
    return redact(value) as T;
  }

  if (typeof value !== 'object' || value === null || !isPlain(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item, redact)) as T;
  }

  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, redactDeep(item as unknown, redact)])) as T;
}

/**
 * Cuts the secret tail off the collector's `Integration token invalid: <key>`.
 * @param message Message from the collector.
 * @returns The message without the tail; other messages unchanged.
 */
export function stripTokenSecret(message: string): string {
  return message.startsWith(TOKEN_INVALID_PREFIX) ? TOKEN_INVALID_PREFIX : message;
}
