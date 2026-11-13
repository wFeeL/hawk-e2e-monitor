/** Start the service. */
export interface ServeCommand {
  /** Discriminant. */
  kind: 'serve';
}

/** Show usage and fail. */
export interface UsageCommand {
  /** Discriminant. */
  kind: 'usage';
  /** Text for stderr, ends with a newline. */
  message: string;
}

/** Parsed command line. */
export type Command = ServeCommand | UsageCommand;

/** Usage text printed for an unknown command. */
export const USAGE = 'Usage: hawk-e2e-monitor [serve]\n';

/**
 * Parses arguments after the script name.
 * @param args Command line arguments.
 * @returns `serve` for no arguments or `serve`, usage text otherwise.
 */
export function parseCommand(args: readonly string[]): Command {
  if (args.length === 0 || (args.length === 1 && args[0] === 'serve')) {
    return { kind: 'serve' };
  }

  return { kind: 'usage',
    message: `Unknown command "${args.join(' ')}".\n${USAGE}` };
}
