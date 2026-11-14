import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../engine/result.js';
import type { CheckCommand } from '../cli.js';
import { startFakeHawk } from '../test-support/fake-hawk/index.js';
import type { FakeHawk } from '../test-support/fake-hawk/index.js';
import { createTestDeps } from '../test-support/scenario.js';
import { runCheckCommand } from './check.js';
import type { CheckIo } from './check.js';

const COMMAND: CheckCommand = { kind: 'check',
  scenario: 'send-and-receive-event',
  sequence: 1,
  repeat: false };

let hawk: FakeHawk;

beforeEach(async () => {
  hawk = await startFakeHawk();
});

afterEach(async () => {
  await hawk.close();
});

/** One line of the log. */
interface LogLine {
  /** Log message. */
  msg: string;
}

/** What a run wrote and returned. */
interface Captured {
  /** Exit code. */
  code: number;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Runs the command on the fake Hawk and captures its output.
 * @param command Parsed command.
 * @returns Exit code and both streams.
 */
async function runCommand(command: CheckCommand = COMMAND): Promise<Captured> {
  const { deps } = createTestDeps(hawk);
  const captured: Captured = { code: -1,
    stdout: '',
    stderr: '' };
  const io: CheckIo = {
    stdout: (text) => {
      captured.stdout += text;
    },
    stderr: (text) => {
      captured.stderr += text;
    },
  };

  captured.code = await runCheckCommand(command, deps.config, io, { pollScheduleMs: deps.pollScheduleMs });

  return captured;
}

describe('runCheckCommand', () => {
  it('stdout parses as one JSON line with the run result', async () => {
    const { stdout } = await runCommand();
    const result = JSON.parse(stdout) as RunResult;

    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(result).toMatchObject({ scenario: 'send-and-receive-event',
      status: 'ok',
      sequence: 1,
      transport: 'http' });
  });

  it('exit 0 on ok', async () => {
    const { code, stderr } = await runCommand();

    expect(code).toBe(0);
    expect(stderr).toContain('ok');
  });

  it('exit 1 on failure, with a summary line on stderr', async () => {
    hawk.collector.knobs.health = { status: 500,
      redis: false,
      mongo: true };

    const { code, stdout, stderr } = await runCommand();
    const result = JSON.parse(stdout) as RunResult;

    expect(code).toBe(1);
    expect(result).toMatchObject({ status: 'failed',
      failedStage: 'collector_availability',
      errorClass: 'collector_dependency_error' });
    expect(stderr).toContain(`failed collector_availability collector_dependency_error: ${result.message ?? ''}`);
  });

  it('logs go to stderr only', async () => {
    const { stdout, stderr } = await runCommand();
    const logLines = stderr.split('\n').filter(line => line.startsWith('{'));

    expect(logLines.map(line => (JSON.parse(line) as LogLine).msg)).toContain('run finished');
    expect(stdout).not.toContain('run finished');
    expect(JSON.parse(stdout)).toBeTypeOf('object');
  });

  it('passes the transport and repeat flags to the run', async () => {
    const { code, stdout } = await runCommand({ ...COMMAND,
      sequence: 3,
      transport: 'ws',
      repeat: true });
    const result = JSON.parse(stdout) as RunResult;

    expect(code).toBe(0);
    expect(result).toMatchObject({ sequence: 3,
      transport: 'ws' });
    expect(result.stages.find(stage => stage.name === 'event_repeated')?.status).toBe('ok');
  });

  it('without --repeat the repeat follows the config', async () => {
    const { stdout } = await runCommand({ ...COMMAND,
      sequence: 1 });
    const result = JSON.parse(stdout) as RunResult;

    expect(result.stages.find(stage => stage.name === 'event_repeated')?.status).toBe('skipped');
  });

  it('writes no password or token to either stream', async () => {
    const { stdout, stderr } = await runCommand();

    for (const secret of [hawk.password, hawk.token]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });
});
