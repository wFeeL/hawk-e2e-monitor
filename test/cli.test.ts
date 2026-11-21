import { describe, expect, it } from 'vitest';
import { configErrorExitCode, parseCommand, USAGE } from '../src/cli.js';
import { SCENARIO_NAMES } from '../src/scenarios/names.js';

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

  it('usage has one check line that lists every scenario', () => {
    const checkLines = USAGE.split('\n').filter(line => line.includes('check <scenario>'));

    expect(checkLines).toHaveLength(1);
    expect(checkLines[0]).toContain('[--sequence <n>] [--transport http|ws] [--repeat]');
    expect(USAGE).toContain(SCENARIO_NAMES.join('|'));
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
      stats: false,
      json: false });
  });

  it('history takes a scenario, a limit and --stats', () => {
    expect(parseCommand(['history', '--scenario', 'check-notification', '--limit', '1000', '--stats'])).toEqual({ kind: 'history',
      scenario: 'check-notification',
      limit: 1000,
      stats: true,
      json: false });
    expect(parseCommand(['history', '--limit', '1'])).toMatchObject({ limit: 1 });
  });

  it('history --json asks for JSON lines, with or without --stats', () => {
    expect(parseCommand(['history', '--json'])).toMatchObject({ kind: 'history',
      json: true,
      stats: false });
    expect(parseCommand(['history', '--stats', '--json'])).toMatchObject({ json: true,
      stats: true });
  });

  it.each(['new-project', 'sourcemaps', 'sentry-envelope'])('check %s keeps --sequence but rejects --transport and --repeat', (scenario) => {
    expect(parseCommand(['check', scenario, '--sequence', '3'])).toMatchObject({ kind: 'check',
      sequence: 3 });

    for (const flags of [['--transport', 'ws'], ['--repeat']]) {
      const command = parseCommand(['check', scenario, ...flags]);

      expect(command.kind).toBe('usage');
      expect(command.kind === 'usage' ? command.message : '').toContain(`${flags[0] ?? ''} does not apply to ${scenario}`);
    }
  });

  it('check telegram-delivery still takes --transport and --repeat', () => {
    expect(parseCommand(['check', 'telegram-delivery', '--transport', 'http', '--repeat'])).toMatchObject({ transport: 'http',
      repeat: true });
  });

  it('usage says where --transport and --repeat apply', () => {
    expect(USAGE).toContain('--transport and --repeat apply to send-and-receive-event, check-notification, telegram-delivery only');
    expect(USAGE).toContain('[--stats] [--json]');
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
    expect(USAGE).toContain('run [<scenario> ...]');
  });
});

describe('help and version', () => {
  it.each([['--help'], ['-h'], ['help'], ['serve', '--help'], ['run', '--help'], ['check', '--help'],
    ['check', 'sourcemaps', '--help'], ['provision', '-h'], ['history', '--help']])('%j prints the usage', (...args) => {
    expect(parseCommand(args)).toEqual({ kind: 'help',
      text: USAGE });
  });

  it('--version asks for the version', () => {
    expect(parseCommand(['--version'])).toEqual({ kind: 'version' });
  });

  it('names the program as it is started and describes every command', () => {
    expect(USAGE).toContain('node dist/main.js');
    expect(USAGE).not.toContain('hawk-e2e-monitor');

    for (const command of ['serve', 'check', 'run', 'provision', 'history']) {
      expect(USAGE).toMatch(new RegExp(`^ {2}${command}\\b`, 'mu'));
    }
  });

  it('still treats an unknown option as a mistake', () => {
    expect(parseCommand(['--bogus']).kind).toBe('usage');
  });
});

describe('configErrorExitCode', () => {
  it('is 2, whatever the command, and a failed check keeps 1', () => {
    expect(configErrorExitCode()).toBe(2);
  });
});
