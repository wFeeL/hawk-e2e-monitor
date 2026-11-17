import type { Transport } from './clients/collector.js';
import { SCENARIO_NAMES, SCENARIO_TRAITS } from './scenarios/names.js';
import type { ScenarioName } from './scenarios/names.js';
import { DEFAULT_LIST_LIMIT } from './storage/types.js';

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

/** Parsed command line. */
export type Command = CheckCommand | HistoryCommand | ProvisionCommand | ServeCommand | UsageCommand;

/** Usage text printed for an unknown command. */
export const USAGE = [
  'Usage: hawk-e2e-monitor [serve]',
  ...SCENARIO_NAMES.map(name => `       hawk-e2e-monitor check ${name}${SCENARIO_TRAITS[name].sendsEvents ? ' [--sequence <n>] [--transport http|ws] [--repeat]' : ''}`),
  '       hawk-e2e-monitor provision [--no-wait]',
  '       hawk-e2e-monitor history [--scenario <name>] [--limit <n>] [--stats]',
  '',
].join('\n');

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
 * Parses arguments after the script name.
 * @param args Command line arguments.
 * @returns `serve` for no arguments or `serve`, `check` or `provision` with their options, usage text otherwise.
 */
export function parseCommand(args: readonly string[]): Command {
  if (args.length === 0 || (args.length === 1 && args[0] === 'serve')) {
    return { kind: 'serve' };
  }

  if (args[0] === 'check') {
    return parseCheck(args.slice(1));
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
