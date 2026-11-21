import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/database.js';
import { createHistory } from '../../src/storage/history.js';
import { tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';
import { reservedPort } from '../support/ports.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'dist', 'main.js');
const STOP_LIMIT_MS = 10_000;
const READY_LIMIT_MS = 20_000;
const POLL_MS = 100;

/** What a finished process wrote. */
interface Finished {
  /** Exit code. */
  code: number | null;
  /** Everything written to stdout. */
  stdout: string;
  /** Everything written to stderr. */
  stderr: string;
}

/** A process that is still running. */
interface Running {
  /** Resolves when the process has ended. */
  done: Promise<Finished>;
  /** Sends a signal to the process. */
  signal: (name: NodeJS.Signals) => void;
  /** Output so far, for messages of failed waits. */
  output: () => string;
}

/** The part of `package.json` the version test reads. */
interface PackageInfo {
  /** Version of the service. */
  version: string;
}

const cleanups: Array<() => Promise<void>> = [];

/**
 * Finds the newest modification time of the files under a directory.
 * @param directory Directory to walk.
 * @returns Newest `mtimeMs`, 0 for an empty tree.
 */
function newestMtime(directory: string): number {
  let newest = 0;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }

  return newest;
}

/**
 * Starts the built entry point with exactly the given environment.
 * @param args Arguments after `dist/main.js`.
 * @param env Whole environment of the process; nothing is inherited.
 * @returns The running process.
 */
function start(args: string[], env: Record<string, string>): Running {
  const child = spawn(process.execPath, [ENTRY, ...args], { cwd: ROOT,
    env });
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const done = new Promise<Finished>((resolve) => {
    child.on('close', (code) => {
      resolve({ code,
        stdout,
        stderr });
    });
  });

  cleanups.push(async () => {
    child.kill('SIGKILL');
    await done;
  });

  return { done,
    signal: name => child.kill(name),
    output: () => `stdout: ${stdout}\nstderr: ${stderr}` };
}

/**
 * Runs the built entry point to its end.
 * @param args Arguments after `dist/main.js`.
 * @param env Whole environment of the process.
 * @returns Exit code and both streams.
 */
async function runToEnd(args: string[], env: Record<string, string> = {}): Promise<Finished> {
  return start(args, env).done;
}

beforeAll(() => {
  let built = 0;

  try {
    built = statSync(ENTRY).mtimeMs;
  } catch {
    // A missing file is reported below with the rest.
  }

  if (built === 0 || built < newestMtime(join(ROOT, 'src'))) {
    throw new Error('run npm run build first');
  }
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe('built entry point', () => {
  it('prints the usage for --help and for a command with --help, without reading the configuration', async () => {
    for (const args of [['--help'], ['-h'], ['help'], ['run', '--help']]) {
      const result = await runToEnd(args);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage: node dist/main.js <command>');
      expect(result.stderr).toBe('');
    }
  });

  it('prints the version of package.json for --version', async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as PackageInfo;
    const result = await runToEnd(['--version']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${pkg.version}\n`);
  });

  it('ends a check with exit code 2 and the list of problems when the configuration is empty', async () => {
    const result = await runToEnd(['check', 'endpoints-probe']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Invalid configuration:');
  });

  it('ends serve with exit code 2 for an empty configuration', async () => {
    expect((await runToEnd([])).code).toBe(2);
  });

  describe('history', () => {
    let database: TempDatabase;

    afterEach(async () => {
      await database.remove();
    });

    it('reads a database with only DATABASE_PATH set', async () => {
      database = await tempDatabase();

      const history = createHistory(openDatabase(database.path));

      history.startRun({ runId: 'raaaaaaaaaaaaaaaa',
        scenario: 'send-and-receive-event',
        sequence: 1,
        trigger: 'schedule',
        startedAt: '2026-03-10T10:00:00.000Z' });
      history.finishRun('raaaaaaaaaaaaaaaa', { status: 'ok',
        finishedAt: '2026-03-10T10:00:01.000Z',
        durationMs: 705.9054660000002,
        degraded: [] });
      history.close();

      const result = await runToEnd(['history'], { DATABASE_PATH: database.path });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/^STARTED +SCENARIO +STATUS +DURATION +STAGE +CLASS\n2026-03-10T10:00:00\.000Z +send-and-receive-event +ok +706 ms +- +-\n$/u);
    });

    it('says there is no history for a missing file instead of asking for the Hawk settings', async () => {
      database = await tempDatabase();

      const result = await runToEnd(['history'], { DATABASE_PATH: database.path });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe(`No history at ${database.path}\n`);
    });
  });

  describe('serve', () => {
    let hawk: FakeHawk;
    let database: TempDatabase;

    afterEach(async () => {
      await hawk.close();
      await database.remove();
    });

    it('starts against a fake Hawk, answers /healthz and exits 0 on SIGTERM', async () => {
      hawk = await startFakeHawk();
      database = await tempDatabase();

      const port = await reservedPort();
      const running = start(['serve'], { HAWK_API_URL: hawk.api.url,
        HAWK_COLLECTOR_URL: hawk.collector.url,
        HAWK_INTEGRATION_TOKEN: hawk.token,
        HAWK_PROJECT_ID: hawk.projectId,
        HAWK_EMAIL: hawk.email,
        HAWK_PASSWORD: hawk.password,
        INSTANCE_ID: 'smoke',
        SCENARIOS: 'send-and-receive-event',
        INTERNAL_PORT: String(port),
        DATABASE_PATH: database.path });
      let status = 0;

      for (let waited = 0; waited < READY_LIMIT_MS && status !== 200; waited += POLL_MS) {
        status = await fetch(`http://127.0.0.1:${String(port)}/healthz`).then(response => response.status, () => 0);

        if (status !== 200) {
          await sleep(POLL_MS);
        }
      }

      expect(status, running.output()).toBe(200);

      running.signal('SIGTERM');

      const result = await Promise.race([running.done, sleep(STOP_LIMIT_MS).then(() => 'timeout' as const)]);

      expect(result, running.output()).not.toBe('timeout');
      expect(typeof result === 'string' ? undefined : result.code, running.output()).toBe(0);
    });
  });
});
