import { describe, expect, it } from 'vitest';
import { groom } from './grouper.js';

/** A frame of a groomed payload. */
interface Frame {
  /** Source lines of the frame. */
  sourceCode: Array<{
    /** Text of the line. */
    content: string;
  }>;
}

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

describe('groom', () => {
  it('masks sensitive keys in context and addons, nested ones too', () => {
    const result = groom('errors/nodejs', { title: 't',
      context: { password: 'x',
        deep: { TOKEN: 'y',
          fine: 'z' } },
      addons: { token: 'q' } });

    expect(result.context).toEqual({ password: '[filtered]',
      deep: { TOKEN: '[filtered]',
        fine: 'z' } });
    expect(result.addons).toEqual({ token: '[filtered]' });
  });

  it('masks card numbers but not object ids or uuids', () => {
    const result = groom('errors/nodejs', { title: 't',
      context: { card: 'n',
        pan: '4111 1111 1111 1111',
        id: 'a'.repeat(24),
        uuid: '123e4567-e89b-12d3-a456-426614174000' } });

    expect(result.context).toEqual({ card: '[filtered]',
      pan: '[filtered]',
      id: 'a'.repeat(24),
      uuid: '123e4567-e89b-12d3-a456-426614174000' });
  });

  it('leaves everything as sent when the filter is switched off', () => {
    expect(groom('errors/nodejs', { title: 't',
      context: { password: 'x' } }, { unmasked: true }).context).toEqual({ password: 'x' });
  });

  it('cuts the title, long strings, wide objects, long arrays and deep objects', () => {
    const result = groom('errors/nodejs', { title: 't'.repeat(401),
      context: { long: 'y'.repeat(201),
        list: Array.from({ length: 11 }, () => 1),
        wide: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${String(index)}`, 1])),
        a: { b: { c: { d: { e: { f: 1 } } } } } } });
    const context = result.context as Record<string, unknown>;

    expect(result.title).toBe(`${'t'.repeat(400)}…`);
    expect(context.long).toBe(`${'y'.repeat(200)}…`);
    expect(context.list).toHaveLength(11);
    expect((context.list as unknown[]).at(-1)).toBe('<1 more items...>');
    expect(Object.keys(context.wide as object)).toHaveLength(21);
    expect((context.wide as Record<string, unknown>).__meta).toBe('1 more key(s) skipped');
    expect(JSON.stringify(context.a)).toContain('<deep object>');
  });

  it('cuts the source code of a frame', () => {
    const lines = Array.from({ length: 22 }, (_, index) => ({ line: index,
      content: 'z'.repeat(141) }));
    const result = groom('errors/nodejs', { title: 't',
      backtrace: [{ file: 'f',
        sourceCode: lines }] });
    const [frame] = result.backtrace as Frame[];

    expect(frame?.sourceCode).toHaveLength(21);
    expect(frame?.sourceCode[0]?.content).toBe(`${'z'.repeat(140)}…`);
  });

  it('adds beautifiedUserAgent for JavaScript events only', () => {
    const payload = { title: 't',
      addons: { userAgent: USER_AGENT } };

    expect((groom('errors/javascript', payload).addons as Record<string, unknown>).beautifiedUserAgent).toEqual({ os: 'Linux',
      osVersion: 'Unknown',
      browser: 'Chrome',
      browserVersion: '120.0.0.0' });
    expect(groom('errors/nodejs', payload).addons).toEqual({ userAgent: USER_AGENT });
    expect(groom('errors/javascript', payload, { noJsWorker: true }).addons).toEqual({ userAgent: USER_AGENT });
  });

  it('does not touch the payload it was given', () => {
    const payload = { title: 't',
      context: { password: 'x' } };

    groom('errors/nodejs', payload);
    expect(payload.context.password).toBe('x');
  });
});
