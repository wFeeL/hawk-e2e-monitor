import { randomUUID } from 'node:crypto';
import { startFakeApi } from './api.js';
import type { FakeApi } from './api.js';
import { startFakeCollector } from './collector.js';
import type { FakeCollector } from './collector.js';
import { startFakeNotifier } from './notifier.js';
import type { FakeNotifier } from './notifier.js';
import { createFakeRules } from './rules.js';
import type { FakeRules } from './rules.js';
import { createFakeStore, objectIdLike } from './store.js';
import type { FakeStore } from './store.js';
import { decodeTokenKey, encodeToken } from './token.js';

export * from './api.js';
export * from './collector.js';
export * from './notifier.js';
export * from './rules.js';
export * from './store.js';
export * from './token.js';

/** A whole fake Hawk: collector, API, notifier and the events behind them. */
export interface FakeHawk {
  /** HTTP and WebSocket collector. */
  collector: FakeCollector;
  /** GraphQL API. */
  api: FakeApi;
  /** Shared event store. */
  store: FakeStore;
  /** Notification rules shared by the API and the notifier. */
  rules: FakeRules;
  /** Notifier with the webhook and loop senders. */
  notifier: FakeNotifier;
  /** 24 hex project id. */
  projectId: string;
  /** Account email. */
  email: string;
  /** Account password. */
  password: string;
  /** Valid integration token. */
  token: string;
  /**
   * Stops the servers and the notifier.
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
  // The switches live in the API's knobs, which exist only after it starts, so they are read lazily.
  let fakeApi: FakeApi | undefined;
  const rules = createFakeRules({ allowPrivateWebhook: () => fakeApi?.knobs.allowPrivateWebhook ?? true,
    resolves: host => fakeApi?.knobs.unresolvableHosts?.includes(host) !== true });
  const api = await startFakeApi({ store,
    projectId,
    email,
    password,
    token,
    rules });

  fakeApi = api;

  const notifier = startFakeNotifier({ store,
    rules,
    projectId,
    projectName: 'fake-project',
    workspaceId: 'fake-workspace',
    garageUrl: 'http://garage.invalid' });

  return {
    collector,
    api,
    store,
    rules,
    notifier,
    projectId,
    email,
    password,
    token,
    async close() {
      await Promise.all([collector.close(), api.close(), notifier.close()]);
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
