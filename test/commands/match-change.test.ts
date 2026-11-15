import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMatchChange, recordMatchChange } from '../../src/commands/match-change.js';
import type { Config } from '../../src/config/load.js';
import { MATCH_CHANGED_KEY, TELEGRAM_MATCH_CHANGED_KEY } from '../../src/storage/keys.js';
import { testConfig } from '../support/config.js';

const folders: string[] = [];
const io = { stdout: () => undefined,
  stderr: () => undefined };

/**
 * Builds a config whose database is a file in a new temporary folder.
 * @returns Config with that path.
 */
async function configWithFile(): Promise<Config> {
  const folder = await mkdtemp(join(tmpdir(), 'match-change-'));

  folders.push(folder);

  const base = testConfig();

  return { ...base,
    monitoring: { ...base.monitoring,
      databasePath: join(folder, 'monitor.db') } };
}

afterEach(async () => {
  await Promise.all(folders.splice(0).map(async folder => rm(folder, { recursive: true,
    force: true })));
});

describe('match change keys', () => {
  it('keeps the change time of each rule under its own key', async () => {
    const config = await configWithFile();
    const notification = new Date('2026-03-01T10:00:00.000Z');
    const telegram = new Date('2026-03-01T11:30:00.000Z');

    recordMatchChange(config, notification, io, MATCH_CHANGED_KEY);
    expect(readMatchChange(config, io, TELEGRAM_MATCH_CHANGED_KEY)).toBeUndefined();

    recordMatchChange(config, telegram, io, TELEGRAM_MATCH_CHANGED_KEY);

    expect(readMatchChange(config, io, MATCH_CHANGED_KEY)).toBe(notification.getTime());
    expect(readMatchChange(config, io, TELEGRAM_MATCH_CHANGED_KEY)).toBe(telegram.getTime());
  });

  it('names the Telegram key apart from the other one', () => {
    expect(TELEGRAM_MATCH_CHANGED_KEY).toBe('rule_match_changed_at:telegram');
    expect(TELEGRAM_MATCH_CHANGED_KEY).not.toBe(MATCH_CHANGED_KEY);
  });
});
