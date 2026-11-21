import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMutableRedactor, createRedactor, redactDeep, stripTokenSecret } from '../../src/errors/redact.js';

describe('mutable redactor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds the same value 1000 times and still masks it once', () => {
    const { redact, add } = createMutableRedactor([]);
    const sorts = vi.spyOn(Array.prototype, 'toSorted');

    for (let i = 0; i < 1000; i += 1) {
      add('https://a.example');
    }

    add('a.example');

    // One rebuild per new value; the 999 repeats rebuild nothing.
    expect(sorts).toHaveBeenCalledTimes(2);
    sorts.mockClear();
    expect(redact('see https://a.example')).toBe('see ***');
    expect(sorts).not.toHaveBeenCalled();
  });

  it('masks a secret added after creation and keeps the old ones', () => {
    const { redact, add } = createMutableRedactor(['first-secret']);

    expect(redact('first-secret and later.example.com')).toBe('*** and later.example.com');

    add('later.example.com');

    expect(redact('first-secret and later.example.com')).toBe('*** and ***');
  });

  it('masks the longer value first and ignores short ones', () => {
    const { redact, add } = createMutableRedactor([]);

    add('host.example.com');
    add('host.example.com:8443');
    add('ab');

    expect(redact('https://host.example.com:8443/ ab')).toBe('https://***/ ab');
  });
});

describe('redact', () => {
  it('redactor masks every secret occurrence', () => {
    const redact = createRedactor(['hunter22', 'abcd-1234', 'xy']);

    expect(redact('a hunter22 b hunter22 c abcd-1234 xy')).toBe('a *** b *** c *** xy');
  });

  it('redactor masks the longer secret first', () => {
    const redact = createRedactor(['abcd', 'abcdefgh']);

    expect(redact('abcdefgh')).toBe('***');
  });

  it('redactDeep walks nested arrays and objects', () => {
    const redact = createRedactor(['secret-value']);
    const date = new Date(0);
    const input = { a: 'x secret-value',
      list: ['secret-value', { deep: 'secret-value!' }, 5],
      secretKey: 1,
      date };
    const output = redactDeep(input, redact);

    expect(output).toEqual({ a: 'x ***',
      list: ['***', { deep: '***!' }, 5],
      secretKey: 1,
      date });
    expect(output.date).toBe(date);
    expect(input.a).toBe('x secret-value');
  });

  it('stripTokenSecret', () => {
    expect(stripTokenSecret('Integration token invalid: abc123')).toBe('Integration token invalid');
    expect(stripTokenSecret('Integration token invalid')).toBe('Integration token invalid');
    expect(stripTokenSecret('Bad: thing')).toBe('Bad: thing');
  });
});

describe('redaction of encoded forms and nested errors', () => {
  const secret = 'pa ss"w/ord9';

  it('masks the URL-encoded and the JSON-escaped form of a secret', () => {
    const redact = createRedactor([secret]);

    expect(redact(`a ${encodeURIComponent(secret)} b`)).toBe('a *** b');
    expect(redact(`{"v":${JSON.stringify(secret)}}`)).toBe('{"v":"***"}');
    expect(redact(`plain ${secret}`)).toBe('plain ***');
  });

  it('a mutable redactor masks the encoded forms of a secret it learned later', () => {
    const { redact, add } = createMutableRedactor([]);

    add(secret);
    expect(redact(encodeURIComponent(secret))).toBe('***');
  });

  it('redactDeep turns an Error inside an array into a plain object with masked fields', () => {
    const redact = createRedactor([secret]);
    const error = new Error(`failed for ${secret}`);
    const [result] = redactDeep([error], redact);

    expect(result).toEqual({ name: 'Error',
      message: 'failed for ***',
      stack: expect.not.stringContaining('ord9') as unknown });
    expect(JSON.stringify(result)).not.toContain('ord9');
  });

  it('redactDeep masks object keys', () => {
    const redact = createRedactor([secret]);

    expect(redactDeep(Object.fromEntries([[`key ${secret}`, 1]]), redact)).toEqual(Object.fromEntries([['key ***', 1]]));
  });
});
