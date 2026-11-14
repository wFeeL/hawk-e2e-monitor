import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { CheckCommand } from '../../src/cli.js';
import { runCheckCommand } from '../../src/commands/check.js';
import { loadConfig } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';

const BASE: CheckCommand = { kind: 'check',
  scenario: 'send-and-receive-event',
  sequence: 1,
  repeat: false };

/** What one `check` run produced. */
interface CheckRun {
  /** Exit code. */
  code: number;
  /** Parsed stdout. */
  result: RunResult;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Runs `check` against the Hawk named by the environment.
 * @param command Command to run.
 * @returns Exit code, parsed result and everything written to stderr.
 */
async function check(command: CheckCommand): Promise<CheckRun> {
  const loaded = loadConfig(process.env);

  if (!loaded.ok) {
    throw new Error(`Invalid configuration: ${JSON.stringify(loaded.errors)}`);
  }

  let stdout = '';
  let stderr = '';
  const code = await runCheckCommand(command, loaded.config, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });

  return { code,
    result: JSON.parse(stdout) as RunResult,
    stderr };
}

describe.skipIf(process.env.E2E_HAWK !== '1')('send-and-receive-event against the Hawk from the environment', () => {
  it('run 1 (HTTP)', async () => {
    const { code, result, stderr } = await check(BASE);

    expect(code, stderr).toBe(0);
    expect(result.status).toBe('ok');
  });

  it('run 2 (WebSocket)', async () => {
    const { code, result, stderr } = await check({ ...BASE,
      sequence: 2 });

    expect(code, stderr).toBe(0);
    expect(result.transport).toBe('ws');
  });

  it('run 1 with a repeat', async () => {
    const { code, result, stderr } = await check({ ...BASE,
      repeat: true });

    expect(code, stderr).toBe(0);
    expect(result.event?.totalCount).toBe(2);
  });
});
