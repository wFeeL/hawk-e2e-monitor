import { describe, expect, it } from 'vitest';
import { configErrorExitCode, parseCommand, USAGE } from '../src/cli.js';

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

  it('the probe takes no options and says so', () => {
    expect(parseCommand(['check', 'endpoints-probe'])).toEqual({ kind: 'check',
      scenario: 'endpoints-probe',
      sequence: 1,
      repeat: false });

    for (const flags of [['--sequence', '2'], ['--transport', 'ws'], ['--repeat']]) {
      const command = parseCommand(['check', 'endpoints-probe', ...flags]);

      expect(command.kind).toBe('usage');
      expect(command.kind === 'usage' ? command.message : '').toContain('endpoints-probe takes no options');
    }
  });

  it('usage lists the probe without options', () => {
    expect(USAGE).toContain('check endpoints-probe\n');
    expect(USAGE).toContain('check check-notification [--sequence');
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

describe('parseCommand run', () => {
  it('run without names means all enabled scenarios', () => {
    expect(parseCommand(['run'])).toEqual({ kind: 'run',
      scenarios: [] });
  });

  it('run keeps the names in the given order', () => {
    expect(parseCommand(['run', 'check-notification', 'sourcemaps'])).toEqual({ kind: 'run',
      scenarios: ['check-notification', 'sourcemaps'] });
  });

  it.each([
    [['run', 'bogus'], 'unknown scenario "bogus"'],
    [['run', 'sourcemaps', 'sourcemaps'], 'sourcemaps given twice'],
    [['run', '--flag'], 'unknown scenario "--flag"'],
  ])('run %j is usage', (args, reason) => {
    const command = parseCommand(args);

    expect(command.kind).toBe('usage');
    expect(command.kind === 'usage' ? command.message : '').toContain(reason);
    expect(command.kind === 'usage' ? command.message : '').toContain(USAGE);
  });

  it('usage lists the run command', () => {
    expect(USAGE).toContain('       hawk-e2e-monitor run [<scenario> ...]\n');
  });
});

describe('configErrorExitCode', () => {
  it('is 2 for run, which says the service cannot be asked, and 1 for the other commands', () => {
    expect(configErrorExitCode(parseCommand(['run']))).toBe(2);
    expect(configErrorExitCode(parseCommand(['serve']))).toBe(1);
    expect(configErrorExitCode(parseCommand(['check', 'sourcemaps']))).toBe(1);
    expect(configErrorExitCode(parseCommand(['history']))).toBe(1);
  });
});
