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
    const command = parseCommand(['deploy']);

    expect(command).toEqual({
      kind: 'usage',
      message: expect.stringContaining('Unknown command "deploy"') as string,
    });
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });

  it('provision waits by default', () => {
    expect(parseCommand(['provision'])).toEqual({ kind: 'provision',
      wait: true });
  });

  it('provision --no-wait does not wait', () => {
    expect(parseCommand(['provision', '--no-wait'])).toEqual({ kind: 'provision',
      wait: false });
  });

  it.each([
    [['provision', '--bogus'], 'unknown option "--bogus"'],
    [['provision', '--no-wait', '--no-wait'], 'twice'],
    [['provision', 'extra'], 'unknown option "extra"'],
  ])('provision %j is usage', (args, reason) => {
    const command = parseCommand(args);

    expect(command.kind).toBe('usage');
    expect(command.kind === 'usage' ? command.message : '').toContain(reason);
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });

  it('check with defaults', () => {
    expect(parseCommand(['check', 'send-and-receive-event'])).toEqual({ kind: 'check',
      scenario: 'send-and-receive-event',
      sequence: 1,
      repeat: false });
  });

  it('check-notification takes the same flags', () => {
    expect(parseCommand(['check', 'check-notification'])).toEqual({ kind: 'check',
      scenario: 'check-notification',
      sequence: 1,
      repeat: false });
    expect(parseCommand(['check', 'check-notification', '--sequence', '2', '--transport', 'ws', '--repeat'])).toEqual({ kind: 'check',
      scenario: 'check-notification',
      sequence: 2,
      transport: 'ws',
      repeat: true });
  });

  it('check-notification rejects a bad flag like the other scenario', () => {
    const command = parseCommand(['check', 'check-notification', '--sequence', '0']);

    expect(command.kind === 'usage' ? command.message : '').toContain('--sequence');
  });

  it('usage names both scenarios', () => {
    expect(USAGE).toContain('check send-and-receive-event');
    expect(USAGE).toContain('check check-notification');
  });

  it('check with every flag', () => {
    expect(parseCommand(['check', 'send-and-receive-event', '--sequence', '4', '--transport', 'ws', '--repeat'])).toEqual({ kind: 'check',
      scenario: 'send-and-receive-event',
      sequence: 4,
      transport: 'ws',
      repeat: true });
  });

  it('flags may come in any order', () => {
    expect(parseCommand(['check', 'send-and-receive-event', '--repeat', '--transport', 'http', '--sequence', '12'])).toEqual({ kind: 'check',
      scenario: 'send-and-receive-event',
      sequence: 12,
      transport: 'http',
      repeat: true });
  });

  it.each([
    [['check'], 'missing scenario'],
    [['check', 'other'], 'unknown scenario "other"'],
    [['check', 'send-and-receive-event', '--sequence', '0'], '--sequence'],
    [['check', 'send-and-receive-event', '--sequence', '-1'], '--sequence'],
    [['check', 'send-and-receive-event', '--sequence', '1.5'], '--sequence'],
    [['check', 'send-and-receive-event', '--sequence', 'abc'], '--sequence'],
    [['check', 'send-and-receive-event', '--sequence'], '--sequence'],
    [['check', 'send-and-receive-event', '--transport', 'udp'], '--transport'],
    [['check', 'send-and-receive-event', '--transport'], '--transport'],
    [['check', 'send-and-receive-event', '--bogus'], 'unknown option "--bogus"'],
    [['check', 'send-and-receive-event', '--repeat', '--repeat'], 'twice'],
    [['check', 'send-and-receive-event', 'extra'], 'unknown option "extra"'],
  ])('check %j is usage', (args, reason) => {
    const command = parseCommand(args);

    expect(command.kind).toBe('usage');
    expect(command.kind === 'usage' ? command.message : '').toContain(reason);
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });

  it('serve with extra arguments is usage', () => {
    expect(parseCommand(['serve', 'extra']).kind).toBe('usage');
  });

  it('history defaults to the last 20 runs', () => {
    expect(parseCommand(['history'])).toEqual({ kind: 'history',
      limit: 20,
      stats: false });
  });

  it('history takes a scenario, a limit and --stats', () => {
    expect(parseCommand(['history', '--scenario', 'check-notification', '--limit', '1000', '--stats'])).toEqual({ kind: 'history',
      scenario: 'check-notification',
      limit: 1000,
      stats: true });
    expect(parseCommand(['history', '--limit', '1'])).toMatchObject({ limit: 1 });
  });

  it.each([
    [['history', '--limit', '0'], '--limit needs a whole number from 1 to 1000'],
    [['history', '--limit', '1001'], '--limit needs a whole number from 1 to 1000'],
    [['history', '--limit', 'abc'], '--limit needs a whole number from 1 to 1000'],
    [['history', '--limit'], '--limit needs a whole number from 1 to 1000'],
    [['history', '--scenario', 'nope'], 'unknown scenario "nope"'],
    [['history', '--scenario'], 'unknown scenario'],
    [['history', '--bogus'], 'unknown option "--bogus"'],
    [['history', '--stats', '--stats'], '--stats given twice'],
    [['history', 'extra'], 'unknown option "extra"'],
  ])('history %j is usage', (args, reason) => {
    const command = parseCommand(args);

    expect(command.kind).toBe('usage');
    expect(command.kind === 'usage' ? command.message : '').toContain(reason);
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });
});
