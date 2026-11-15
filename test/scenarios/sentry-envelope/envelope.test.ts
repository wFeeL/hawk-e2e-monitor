import { describe, expect, it } from 'vitest';
import { buildEnvelope } from '../../../src/scenarios/sentry-envelope/envelope.js';

const SENT_AT = new Date('2026-11-15T12:00:00.123Z');

/** The exception of the event. */
interface ExceptionShape {
  /** Type and value of the exception. */
  values: Array<Record<'type' | 'value', string>>;
}

/** The SDK of the event. */
interface SdkShape {
  /** Name of the SDK. */
  name: string;
  /** Version of the SDK. */
  version: string;
}

/** The parts of the event the tests read. */
interface EventShape {
  /** Exception data. */
  exception: ExceptionShape;
  /** Severity. */
  level: string;
  /** SDK. */
  sdk: SdkShape;
  /** Contexts. */
  contexts: Record<string, Record<string, unknown>>;
}

/** The envelope as the tests take it apart. */
interface Built {
  /** Text of the envelope. */
  text: string;
  /** Its lines, parsed. */
  lines: unknown[];
}

/**
 * Builds the envelope of a run.
 * @returns Text and its lines parsed.
 */
function built(): Built {
  const text = buildEnvelope({ instanceId: 'mon',
    runId: 'rabcdefghijklmno',
    scenario: 'sentry-envelope',
    sentAt: SENT_AT });

  return { text,
    lines: text.split('\n').filter(line => line !== '')
      .map(line => JSON.parse(line) as unknown) };
}

describe('buildEnvelope', () => {
  it('has three lines: the envelope header, the item header and the event', () => {
    const { lines, text } = built();

    expect(lines).toHaveLength(3);
    expect(text.split('\n').filter(line => line !== '')).toHaveLength(3);
  });

  it('puts sent_at in RFC 3339 into the header, which the collector needs for the time of the event', () => {
    const [header] = built().lines as Array<Record<string, string>>;

    expect(header).toEqual(Object.fromEntries([['sent_at', '2026-11-15T12:00:00.123Z']]));
  });

  it('declares one event item', () => {
    expect(built().lines[1]).toEqual({ type: 'event' });
  });

  it('carries the exception that makes the title the monitor looks for, the level, the SDK and the contexts', () => {
    const event = built().lines[2] as EventShape;

    expect(event.exception.values[0]).toEqual({ type: 'E2eMonitorCheck',
      value: '[e2e:mon] rabcdefghijklmno sentry-envelope' });
    expect(event.level).toBe('error');
    expect(event.sdk.name).toBe('sentry.python');
    expect(event.sdk.version).toEqual(expect.any(String));
    expect(event.contexts.e2e).toEqual({ runId: 'rabcdefghijklmno',
      instanceId: 'mon',
      scenario: 'sentry-envelope' });
  });

  it('does not name a JavaScript SDK, so Hawk sends the event to the default worker', () => {
    const { name } = (built().lines[2] as EventShape).sdk;

    for (const javascript of ['browser', 'react', 'vue', 'angular', 'capacirtor', 'electron']) {
      expect(name).not.toContain(javascript);
    }
  });
});
