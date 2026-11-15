import process from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CheckCommand } from '../../src/cli.js';
import { runCheckCommand } from '../../src/commands/check.js';
import { runProvisionCommand } from '../../src/commands/provision.js';
import { loadConfig } from '../../src/config/load.js';
import type { Config } from '../../src/config/load.js';
import type { RunResult } from '../../src/engine/result.js';

const BASE: CheckCommand = { kind: 'check',
  scenario: 'check-notification',
  sequence: 1,
  repeat: false };

/**
 * Loads the configuration of the environment.
 * @returns Validated configuration.
 */
function configOfEnvironment(): Config {
  const loaded = loadConfig(process.env);

  if (!loaded.ok) {
    throw new Error(`Invalid configuration: ${JSON.stringify(loaded.errors)}`);
  }

  return loaded.config;
}

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
  const config = configOfEnvironment();
  let stdout = '';
  let stderr = '';
  const code = await runCheckCommand(command, config, {
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

/**
 * Checks what a healthy run must show: the check was not skipped and every channel arrived.
 * @param result Result of the run.
 * @param withLoop Whether the loop channel is on.
 */
function expectNotified(result: RunResult, withLoop: boolean): void {
  expect(result.stages.find(stage => stage.name === 'notification_formed')?.status).toBe('ok');
  expect(result.notification?.webhook).toBeDefined();
  if (withLoop) {
    expect(result.notification?.loop).toBeDefined();
  }
  expect(result.warnings).toEqual([]);
}

describe.skipIf(process.env.E2E_HAWK !== '1')('check-notification against the Hawk from the environment', () => {
  // `provision` waits until Hawk has reloaded its rules, so the first run is not skipped for the warmup.
  beforeAll(async () => {
    let stderr = '';
    const code = await runProvisionCommand({ kind: 'provision',
      wait: true }, configOfEnvironment(), {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(code, stderr).toBe(0);
  }, 300_000);

  it('run 1 (HTTP)', async () => {
    const { code, result, stderr } = await check(BASE);

    expect(code, stderr).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.scenario).toBe('check-notification');
    expectNotified(result, configOfEnvironment().notifications.loop);
  }, 300_000);

  it('run 2 (WebSocket)', async () => {
    const { code, result, stderr } = await check({ ...BASE,
      sequence: 2 });

    expect(code, stderr).toBe(0);
    expect(result.transport).toBe('ws');
    expectNotified(result, configOfEnvironment().notifications.loop);
  }, 300_000);
});
