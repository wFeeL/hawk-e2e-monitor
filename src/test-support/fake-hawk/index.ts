import { randomUUID } from 'node:crypto';
import { startFakeApi } from './api.js';
import type { FakeApi } from './api.js';
import { startFakeCollector } from './collector.js';
import type { FakeCollector } from './collector.js';
import { createFakeStore, objectIdLike } from './store.js';
import type { FakeStore } from './store.js';
import { decodeTokenKey, encodeToken } from './token.js';

export * from './api.js';
export * from './collector.js';
export * from './store.js';
export * from './token.js';

/** A whole fake Hawk: collector, API and the events behind them. */
export interface FakeHawk {
  /** HTTP and WebSocket collector. */
  collector: FakeCollector;
  /** GraphQL API. */
  api: FakeApi;
  /** Shared event store. */
  store: FakeStore;
  /** 24 hex project id. */
  projectId: string;
  /** Account email. */
  email: string;
  /** Account password. */
  password: string;
  /** Valid integration token. */
  token: string;
  /**
   * Stops both servers.
   * @returns Resolves when both ports are released.
   */
  close(): Promise<void>;
}

/**
 * Starts the collector and the API over one store.
 * @returns Running fake Hawk with a fresh project and token.
 */
export async function startFakeHawk(): Promise<FakeHawk> {
  const store = createFakeStore();
  const projectId = objectIdLike();
  const token = encodeToken(randomUUID(), randomUUID());
  const email = 'monitor@example.com';
  const password = randomUUID();
  const collector = await startFakeCollector({ store,
    projectId,
    validTokenKey: decodeTokenKey(token) ?? '',
    blocked: () => false });
  const api = await startFakeApi({ store,
    projectId,
    email,
    password,
    token });

  return {
    collector,
    api,
    store,
    projectId,
    email,
    password,
    token,
    async close() {
      await Promise.all([collector.close(), api.close()]);
    },
  };
}

/**
 * Builds the monitor's environment variables that point at a fake Hawk.
 * @param hawk Running fake Hawk.
 * @returns Variables for `loadConfig`.
 */
export function fakeHawkEnv(hawk: FakeHawk): Record<string, string> {
  return {
    INSTANCE_ID: 'fake',
    HAWK_API_URL: hawk.api.url,
    HAWK_COLLECTOR_URL: hawk.collector.url,
    HAWK_INTEGRATION_TOKEN: hawk.token,
    HAWK_PROJECT_ID: hawk.projectId,
    HAWK_EMAIL: hawk.email,
    HAWK_PASSWORD: hawk.password,
  };
}
