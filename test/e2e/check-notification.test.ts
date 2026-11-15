import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { CheckCommand } from '../../src/cli.js';
import { runCheckCommand } from '../../src/commands/check.js';
import { loadConfig } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';

const BASE: CheckCommand = { kind: 'check',
  scenario: 'check-notification',
  sequence: 1,
  repeat: false };

/** What one `check check-notification` run produced. */
interface CheckRun {
  /** Exit code. */
  code: number;
  /** Parsed stdout. */
  result: RunResult;
  /** Everything written to stderr. */
  stderr: string;
}

/**
 * Runs `check check-notification` against the Hawk named by the environment.
 * The environment must also hold RECEIVER_SECRET and PUBLIC_BASE_URL or TUNNEL_METRICS_URL, and the tunnel must lead to RECEIVER_PORT.
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

describe.skipIf(process.env.E2E_HAWK !== '1')('check-notification against the Hawk from the environment', () => {
  // The first run after a change of the rule may skip the notification check while Hawk reloads its rules; it is still ok.
  it('run 1 (HTTP)', async () => {
    const { code, result, stderr } = await check(BASE);

    expect(code, stderr).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.scenario).toBe('check-notification');
  }, 300_000);

  it('run 2 (WebSocket)', async () => {
    const { code, result, stderr } = await check({ ...BASE,
      sequence: 2 });

    expect(code, stderr).toBe(0);
    expect(result.transport).toBe('ws');
  }, 300_000);
});
