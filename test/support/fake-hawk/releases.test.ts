import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSourceMap, expectedSourceCode } from '../../../src/scenarios/sourcemaps/map.js';
import { startFakeHawk } from './index.js';
import type { FakeHawk } from './index.js';
import { createFakeReleases } from './releases.js';

const hawks: FakeHawk[] = [];
const RUN_ID = 'rabcdefghijklmno';

/** A file in a release answer. */
interface FileShape {
  /** Bundle the map describes. */
  originFileName: string;
}

/** The release in an answer. */
interface ReleaseShape {
  /** Number of files. */
  filesCount: number;
  /** The files. */
  files: FileShape[];
}

/** The data the tests read. */
interface DataShape {
  /** Sign-in. */
  login: Record<'accessToken', string>;
  /** Project selection. */
  project: Record<'releaseDetails', ReleaseShape>;
}

/** A GraphQL error. */
interface ErrorShape {
  /** Message. */
  message: string;
  /** Extensions with the code. */
  extensions: Record<'code', string>;
}

/** Parts of a GraphQL answer the tests read. */
interface Answer {
  /** Data, if any. */
  data?: DataShape;
  /** Errors, if any. */
  errors?: ErrorShape[];
}

/** What differs from a good upload. */
interface UploadOptions {
  /** Release name, a good one by default; false leaves the field out. */
  release?: string | false;
  /** Integration token, the project's by default. */
  token?: string;
  /** Whole header, replaces the token. */
  authorization?: string;
}

/** A map file as the store keeps it. */
interface MapFile {
  /** Name of the map. */
  mapFileName: string;
  /** Bundle the map describes. */
  originFileName: string;
  /** Text of the map. */
  content: string;
}

/**
 * Starts a fake Hawk that closes after the test.
 * @returns Fake Hawk.
 */
async function start(): Promise<FakeHawk> {
  const hawk = await startFakeHawk();

  hawks.push(hawk);

  return hawk;
}

/**
 * Uploads a release the way the collector expects it.
 * @param hawk Fake Hawk.
 * @param options What differs from a good upload.
 * @returns HTTP status and the message of the answer.
 */
async function upload(hawk: FakeHawk, options: UploadOptions = {}): Promise<[number, string]> {
  const built = buildSourceMap(RUN_ID);
  const form = new FormData();

  if (options.release !== false) {
    form.append('release', options.release ?? 'rel-1');
  }

  form.append('file', new Blob([JSON.stringify(built.map)]), `${built.fileName}.map`);

  const response = await fetch(new URL('/release', hawk.collector.url), { method: 'POST',
    headers: new Headers([['authorization', options.authorization ?? `Bearer ${options.token ?? hawk.token}`]]),
    body: form });
  const body = await response.json() as Record<'message', string>;

  return [response.status, body.message];
}

/**
 * Asks Hawk for a release.
 * @param hawk Fake Hawk.
 * @param release Release name.
 * @returns Parsed answer.
 */
async function details(hawk: FakeHawk, release: string): Promise<Answer> {
  const sign = await fetch(hawk.api.url, { method: 'POST',
    headers: new Headers([['content-type', 'application/json']]),
    body: JSON.stringify({ operationName: 'Login',
      variables: { email: hawk.email,
        password: hawk.password } }) });
  const { data } = await sign.json() as Answer;
  const response = await fetch(hawk.api.url, { method: 'POST',
    headers: new Headers([['content-type', 'application/json'], ['authorization', `Bearer ${data?.login.accessToken ?? ''}`]]),
    body: JSON.stringify({ operationName: 'ReleaseDetails',
      variables: { projectId: hawk.projectId,
        release } }) });

  return await response.json() as Answer;
}

/**
 * Sends a JavaScript event with a frame of the minified file.
 * @param hawk Fake Hawk.
 * @param release Release name of the event.
 * @returns The stored event.
 */
async function sendFrame(hawk: FakeHawk, release: string): Promise<Record<string, unknown>> {
  const built = buildSourceMap(RUN_ID);

  await fetch(hawk.collector.url, { method: 'POST',
    body: JSON.stringify({ token: hawk.token,
      catcherType: 'errors/javascript',
      payload: { title: `with ${release}`,
        release,
        backtrace: [{ file: `https://e2e.invalid/${built.fileName}`,
          line: 1,
          column: 0 }] } }) });

  return hawk.store.all(hawk.projectId).find(event => event.payload.title === `with ${release}`)?.payload ?? {};
}

afterEach(async () => {
  await Promise.all(hawks.splice(0).map(async hawk => hawk.close()));
});

describe('fake releases', () => {
  it('keeps the first of two maps with one name', () => {
    const releases = createFakeReleases();
    const file = (content: string): MapFile => ({ mapFileName: 'a.map',
      originFileName: 'a',
      content });

    releases.save('p', 'r', [file('one')]);
    releases.save('p', 'r', [file('two')]);

    expect(releases.find('p', 'r')?.files.map(saved => saved.content)).toEqual(['one']);
    expect(releases.find('p', 'other')).toBeUndefined();
    expect(releases.find('q', 'r')).toBeUndefined();
  });
});

describe('fake collector /release', () => {
  it('takes a good upload and the release shows in Hawk with the bundle the map describes', async () => {
    const hawk = await start();

    expect(await upload(hawk)).toEqual([200, 'OK']);

    const answer = await details(hawk, 'rel-1');

    expect(answer.data?.project.releaseDetails.filesCount).toBe(1);
    expect(answer.data?.project.releaseDetails.files[0]?.originFileName).toBe(`e2e-${RUN_ID}.min.js`);
  });

  it('Hawk says «not found» for a release that was never uploaded', async () => {
    const hawk = await start();
    const answer = await details(hawk, 'nope');

    expect(answer.errors?.[0]).toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(answer.errors?.[0]?.message).toContain('Release "nope" not found');
  });

  it('saves the release only after the delay, while the answer is already 200', async () => {
    const hawk = await start();

    hawk.collector.knobs.releaseSaveDelayMs = 150;

    expect((await upload(hawk))[0]).toBe(200);
    expect((await details(hawk, 'rel-1')).errors).toBeDefined();
    await vi.waitFor(async () => {
      expect((await details(hawk, 'rel-1')).errors).toBeUndefined();
    });
  });

  it('never saves a dropped release', async () => {
    const hawk = await start();

    hawk.collector.knobs.dropReleases = true;

    expect((await upload(hawk))[0]).toBe(200);
    expect((await details(hawk, 'rel-1')).errors).toBeDefined();
  });

  it('answers a canned reply and takes nothing', async () => {
    const hawk = await start();

    hawk.collector.knobs.releaseReply = { status: 400,
      body: '{"code":400,"error":true,"message":"nope"}' };

    expect(await upload(hawk)).toEqual([400, 'nope']);
    expect((await details(hawk, 'rel-1')).errors).toBeDefined();
  });

  it.each([
    ['no authorization', { authorization: 'x' }, 'Provide Authorization header'],
    ['a token that does not decode', { authorization: 'Bearer ###' }, 'Token decoding error'],
    ['no release', { release: false as const }, 'provide `release` form value'],
  ])('refuses %s as the collector does', async (_name, options, message) => {
    const hawk = await start();

    expect(await upload(hawk, options)).toEqual([400, message]);
  });

  it('refuses an unknown token', async () => {
    const hawk = await start();
    const [status, message] = await upload(hawk, { token: Buffer.from(JSON.stringify({ integrationId: 'a',
      secret: 'b' })).toString('base64') });

    expect(status).toBe(400);
    expect(message).toContain('Integration token invalid');
  });

  it('files the release under the project of a token created later', async () => {
    const hawk = await start();
    const made = hawk.projects.create('fake-workspace', 'x');

    expect((await upload(hawk, { token: made?.token ?? '' }))[0]).toBe(200);
    expect(hawk.store.releases.find(made?.id ?? '', 'rel-1')).toBeDefined();
    expect(hawk.store.releases.find(hawk.projectId, 'rel-1')).toBeUndefined();
  });
});

describe('source maps in the fake store', () => {
  it('maps the frame of a JavaScript event of a saved release, with the lines around the place', async () => {
    const hawk = await start();

    await upload(hawk);

    const payload = await sendFrame(hawk, 'rel-1');
    const [frame] = payload.backtrace as Array<Record<string, unknown>>;

    expect(frame).toMatchObject({ file: 'e2e-source.js',
      line: 6,
      column: 0 });
    expect(frame?.sourceCode).toEqual(expectedSourceCode(buildSourceMap(RUN_ID).sourceLines, 6));
  });

  it('leaves the frame alone before the release is saved and with the knob', async () => {
    const hawk = await start();
    const before = await sendFrame(hawk, 'rel-1');

    expect((before.backtrace as Array<Record<string, unknown>>)[0]?.file).toContain('https://e2e.invalid/');

    await upload(hawk);
    hawk.store.knobs.noSourceMaps = true;

    const after = await sendFrame(hawk, 'rel-1x');

    expect((after.backtrace as Array<Record<string, unknown>>)[0]?.file).toContain('https://e2e.invalid/');
  });
});
