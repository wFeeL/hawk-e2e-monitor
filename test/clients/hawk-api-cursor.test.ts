import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphqlTransport } from '../../src/clients/graphql.js';
import type { GraphqlTransport } from '../../src/clients/graphql.js';
import { createHawkApi } from '../../src/clients/hawk-api.js';
import { systemClock } from '../../src/time/clock.js';
import { startFakeHawk } from '../support/fake-hawk/index.js';
import type { FakeHawk } from '../support/fake-hawk/index.js';

const SIGNAL = new AbortController().signal;
const PAGE = 50;

let hawk: FakeHawk;
let seen: Array<Readonly<Record<string, unknown>>>;

beforeEach(async () => {
  hawk = await startFakeHawk();
  seen = [];
});

afterEach(async () => {
  await hawk.close();
});

/**
 * Builds a client whose transport records the variables of the event search.
 * @returns Client on the fake.
 */
function recordingApi(): ReturnType<typeof createHawkApi> {
  const inner = createGraphqlTransport({ url: hawk.api.url,
    httpTimeoutMs: 1000,
    clock: systemClock,
    retry: { attempts: 1,
      delaysMs: [] } });
  const transport: GraphqlTransport = {
    request: async (operation, variables, accessToken, signal) => {
      if (operation.name === 'ProjectDailyEvents') {
        seen.push(variables);
      }

      return inner.request(operation, variables, accessToken, signal);
    },
  };

  return createHawkApi({ transport,
    email: hawk.email,
    password: hawk.password,
    clock: systemClock,
    retry: { attempts: 1,
      delaysMs: [] } });
}

describe('findEventsPage cursor', () => {
  it('returns the cursor Hawk names and sends the one it is given', async () => {
    for (let index = 0; index <= PAGE; index += 1) {
      hawk.store.ingest(hawk.projectId, 'errors/nodejs', { title: `[e2e:cursor] item ${String(index)}` });
    }

    const api = recordingApi();
    const first = await api.findEventsPage(hawk.projectId, 'e2e:cursor', SIGNAL);

    expect(first.nextCursor).toMatchObject({ groupingTimestampBoundary: 0,
      sortValueBoundary: 0 });
    expect(seen[0]?.cursor).toBeUndefined();

    await api.findEventsPage(hawk.projectId, 'e2e:cursor', SIGNAL, first.nextCursor);

    expect(seen[1]?.cursor).toEqual(first.nextCursor);
  });

  it('has no cursor on a page that is the last one', async () => {
    hawk.store.ingest(hawk.projectId, 'errors/nodejs', { title: '[e2e:cursor] only' });

    const page = await recordingApi().findEventsPage(hawk.projectId, 'e2e:cursor', SIGNAL);

    expect(page.nextCursor).toBeUndefined();
    expect(page.more).toBe(false);
  });
});
