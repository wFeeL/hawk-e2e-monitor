import { describe, expect, it } from 'vitest';
import { createMutableRedactor, createRedactor, redactDeep, stripTokenSecret } from './redact.js';

describe('mutable redactor', () => {
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
