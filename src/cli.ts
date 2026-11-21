import type { Transport } from './clients/collector.js';
import { SCENARIO_NAMES, SCENARIO_TRAITS } from './scenarios/names.js';
import type { ScenarioName } from './scenarios/names.js';
import { DEFAULT_LIST_LIMIT } from './storage/types.js';

/** Ask the running service to run scenarios now. */
export interface RunCommand {
  /** Discriminant. */
  kind: 'run';
  /** Scenarios to run in this order; empty means every enabled one. */
  scenarios: ScenarioName[];
}

/** Start the service. */
export interface ServeCommand {
  /** Discriminant. */
  kind: 'serve';
}

/** Run one scenario once and print its result. */
export interface CheckCommand {
  /** Discriminant. */
  kind: 'check';
  /** Scenario to run. */
  scenario: ScenarioName;
  /** Run number; picks the transport and the repeat unless they are forced. */
  sequence: number;
  /** Forced transport. */
  transport?: Transport;
  /** Forces the repeat; without it the repeat follows the configuration. */
  repeat: boolean;
}

/** Bring the notification rule of the instance to the wanted state. */
export interface ProvisionCommand {
  /** Discriminant. */
  kind: 'provision';
  /** False with `--no-wait`: do not wait for Hawk to reload the rules. */
  wait: boolean;
}

/** Print stored runs or their statistics. */
export interface HistoryCommand {
  /** Discriminant. */
  kind: 'history';
  /** Only this scenario. */
  scenario?: ScenarioName;
  /** Most runs to print, 1 to 1000. */
  limit: number;
  /** Print statistics instead of runs. */
  stats: boolean;
}

/** Show usage and fail. */
export interface UsageCommand {
  /** Discriminant. */
  kind: 'usage';
  /** Text for stderr, ends with a newline. */
  message: string;
}

/** Print the usage and succeed. */
export interface HelpCommand {
  /** Discriminant. */
  kind: 'help';
  /** Text for stdout, ends with a newline. */
  text: string;
}

/** Print the version and succeed. */
export interface VersionCommand {
  /** Discriminant. */
  kind: 'version';
}

/** Parsed command line. */
export type Command = CheckCommand | HelpCommand | HistoryCommand | ProvisionCommand | RunCommand | ServeCommand | UsageCommand | VersionCommand;

/** Usage text, printed for `--help` and after a mistake in the arguments. */
export const USAGE = [
  'Usage: node dist/main.js <command> [options]',
  '',
  'Commands:',
  '  serve',
  '      Start the monitor; this is the default without a command.',
  '  check <scenario> [--sequence <n>] [--transport http|ws] [--repeat]',
  `      Run one scenario once and print its result. Scenarios: ${SCENARIO_NAMES.join('|')}.`,
  '  run [<scenario> ...]',
  '      Ask the running monitor to run the scenarios now; without names, every enabled one.',
  '  provision [--no-wait]',
  '      Bring the notification rule of the Hawk project to the wanted state.',
  '  history [--scenario <name>] [--limit <n>] [--stats]',
  '      Print the stored runs or, with --stats, their statistics.',
  '',
  'Options:',
  '  -h, --help     Print this text.',
  '  --version      Print the version.',
  '',
].join('\n');

/**
 * Tells which exit code a configuration error ends a command with.
 * @returns 2 for every command, so a wrapper can tell a broken configuration from a failed check, which exits with 1.
 */
export function configErrorExitCode(): number {
  return 2;
}

const COMMAND_NAMES: readonly string[] = ['serve', 'check', 'run', 'provision', 'history'];
const MAX_HISTORY_COMMAND_LIMIT = 1000;
const SEQUENCE_PATTERN = /^[1-9]\d*$/u;

/**
 * Builds a usage result for bad `check` arguments.
 * @param reason What is wrong, without a trailing period.
 * @returns Usage command with the reason and the usage text.
 */
function invalid(reason: string): UsageCommand {
  return { kind: 'usage',
    message: `Invalid arguments: ${reason}.\n${USAGE}` };
}

/**
 * Parses the arguments after `check`.
 * @param args Scenario name and flags.
 * @returns Check command, or usage naming the problem.
 */
function parseCheck(args: readonly string[]): CheckCommand | UsageCommand {
  const [scenario, ...flags] = args;

  if (scenario === undefined) {
    return invalid('missing scenario');
  }

  const known = SCENARIO_NAMES.find(name => name === scenario);

  if (known === undefined) {
    return invalid(`unknown scenario "${scenario}"`);
  }

  if (!SCENARIO_TRAITS[known].sendsEvents && flags.length > 0) {
    return invalid(`${known} takes no options`);
  }

  const command: CheckCommand = { kind: 'check',
    scenario: known,
    sequence: 1,
    repeat: false };
  const seen = new Set<string>();

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? '';

    if (seen.has(flag)) {
      return invalid(`${flag} given twice`);
    }

    seen.add(flag);

    if (flag === '--repeat') {
      command.repeat = true;
    } else if (flag === '--sequence' || flag === '--transport') {
      i += 1;

      const value = flags[i];

      if (flag === '--sequence') {
        if (value === undefined || !SEQUENCE_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
          return invalid('--sequence needs a positive whole number');
        }

        command.sequence = Number(value);
      } else {
        if (value !== 'http' && value !== 'ws') {
          return invalid('--transport needs http or ws');
        }

        command.transport = value;
      }
    } else {
      return invalid(`unknown option "${flag}"`);
    }
  }

  return command;
}

/**
 * Parses the arguments after `provision`.
 * @param flags Flags of the command.
 * @returns Provision command, or usage naming the problem.
 */
function parseProvision(flags: readonly string[]): ProvisionCommand | UsageCommand {
  const seen = new Set<string>();
  let wait = true;

  for (const flag of flags) {
    if (seen.has(flag)) {
      return invalid(`${flag} given twice`);
    }

    seen.add(flag);

    if (flag === '--no-wait') {
      wait = false;
    } else {
      return invalid(`unknown option "${flag}"`);
    }
  }

  return { kind: 'provision',
    wait };
}

/**
 * Parses the arguments after `history`.
 * @param flags Flags of the command.
 * @returns History command, or usage naming the problem.
 */
function parseHistory(flags: readonly string[]): HistoryCommand | UsageCommand {
  const command: HistoryCommand = { kind: 'history',
    limit: DEFAULT_LIST_LIMIT,
    stats: false };
  const seen = new Set<string>();

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i] ?? '';

    if (seen.has(flag)) {
      return invalid(`${flag} given twice`);
    }

    seen.add(flag);

    if (flag === '--stats') {
      command.stats = true;
    } else if (flag === '--scenario') {
      i += 1;

      const value = flags[i];
      const known = SCENARIO_NAMES.find(name => name === value);

      if (known === undefined) {
        return invalid(`unknown scenario "${value ?? ''}"`);
      }

      command.scenario = known;
    } else if (flag === '--limit') {
      i += 1;

      const value = flags[i];
      const limit = Number(value);

      if (value === undefined || !SEQUENCE_PATTERN.test(value) || limit > MAX_HISTORY_COMMAND_LIMIT) {
        return invalid(`--limit needs a whole number from 1 to ${String(MAX_HISTORY_COMMAND_LIMIT)}`);
      }

      command.limit = limit;
    } else {
      return invalid(`unknown option "${flag}"`);
    }
  }

  return command;
}

/**
 * Parses the arguments after `run`.
 * @param names Scenario names; may be empty.
 * @returns Run command, or usage naming the problem.
 */
function parseRun(names: readonly string[]): RunCommand | UsageCommand {
  const scenarios: ScenarioName[] = [];

  for (const name of names) {
    const known = SCENARIO_NAMES.find(candidate => candidate === name);

    if (known === undefined) {
      return invalid(`unknown scenario "${name}"`);
    }

    if (scenarios.includes(known)) {
      return invalid(`${known} given twice`);
    }

    scenarios.push(known);
  }

  return { kind: 'run',
    scenarios };
}

/**
 * Parses arguments after the script name.
 * @param args Command line arguments.
 * @returns `serve` for no arguments or `serve`, `check` or `provision` with their options, usage text otherwise.
 */
export function parseCommand(args: readonly string[]): Command {
  const [first, ...rest] = args;

  if (first === '--help' || first === '-h' || first === 'help') {
    return { kind: 'help',
      text: USAGE };
  }

  if (first === '--version') {
    return { kind: 'version' };
  }

  if (first !== undefined && COMMAND_NAMES.includes(first) && rest.some(arg => arg === '--help' || arg === '-h')) {
    return { kind: 'help',
      text: USAGE };
  }

  if (args.length === 0 || (args.length === 1 && args[0] === 'serve')) {
    return { kind: 'serve' };
  }

  if (args[0] === 'check') {
    return parseCheck(args.slice(1));
  }

  if (args[0] === 'run') {
    return parseRun(args.slice(1));
  }

  if (args[0] === 'provision') {
    return parseProvision(args.slice(1));
  }

  if (args[0] === 'history') {
    return parseHistory(args.slice(1));
  }

  return { kind: 'usage',
    message: `Unknown command "${args.join(' ')}".\n${USAGE}` };
}
