import { describe, expect, it } from 'vitest';
import { parseCommand, USAGE } from './cli.js';

describe('parseCommand', () => {
  it('no arguments means serve', () => {
    expect(parseCommand([])).toEqual({ kind: 'serve' });
  });

  it('serve is accepted', () => {
    expect(parseCommand(['serve'])).toEqual({ kind: 'serve' });
  });

  it('unknown command prints usage', () => {
    const command = parseCommand(['provision']);

    expect(command).toEqual({
      kind: 'usage',
      message: expect.stringContaining('Unknown command "provision"') as string,
    });
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });
});
