import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refusalWhileServing } from '../../src/commands/serving.js';
import { seedLease, tempDatabase } from '../support/database.js';
import type { TempDatabase } from '../support/database.js';
import { testConfig } from '../support/config.js';
import type { Config } from '../../src/config/load.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');

let database: TempDatabase;
let config: Config;

beforeEach(async () => {
  database = await tempDatabase();

  const base = testConfig();

  config = { ...base,
    monitoring: { ...base.monitoring,
      databasePath: database.path } };
});

afterEach(async () => {
  await database.remove();
});

describe('refusalWhileServing', () => {
  it('lets a command through when the file is missing', () => {
    expect(refusalWhileServing(config, NOW)).toBeUndefined();
  });

  it('names the file and the lease of a live serve', () => {
    seedLease(database.path, { pid: 7,
      hostname: 'box',
      at: new Date(NOW.getTime() - 4000).toISOString() });

    expect(refusalWhileServing(config, NOW)).toBe(`serve is running for ${database.path} (lease 4 s old, pid 7); stop it first or start the run through serve\n`);
  });

  it('refuses when the file cannot be opened, naming the path, the error and the files to check', async () => {
    await writeFile(database.path, 'this is not a database');

    const text = refusalWhileServing(config, NOW);

    expect(text).toMatch(new RegExp(`^cannot open ${database.path.replaceAll('.', '\\.')} to look for a running serve: .+; check the permissions of the file and of its -wal and -shm files\\n$`, 'u'));
  });
});
