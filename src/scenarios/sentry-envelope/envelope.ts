const SDK_NAME = 'sentry.python';
const SDK_VERSION = '2.0.0';
const EXCEPTION_TYPE = 'E2eMonitorCheck';

/** What goes into an envelope. */
export interface EnvelopeInput {
  /** Id of this monitor. */
  instanceId: string;
  /** Id of the run. */
  runId: string;
  /** Scenario that sends it. */
  scenario: string;
  /** Time written into the header; the collector takes the time of the event from it. */
  sentAt: Date;
}

/**
 * Builds a Sentry envelope with one event the way an SDK sends it: a header, an item header and the event, one JSON per line.
 * The SDK is named as a Python one, which the collector hands to the default worker like any non-browser SDK.
 * @param input Instance, run, scenario and time.
 * @returns Text for the body of the request.
 */
export function buildEnvelope(input: EnvelopeInput): string {
  const event = { exception: { values: [{ type: EXCEPTION_TYPE,
    value: `[e2e:${input.instanceId}] ${input.runId} ${input.scenario}` }] },
  level: 'error',
  sdk: { name: SDK_NAME,
    version: SDK_VERSION },
  contexts: { e2e: { runId: input.runId,
    instanceId: input.instanceId,
    scenario: input.scenario } } };

  return [Object.fromEntries([['sent_at', input.sentAt.toISOString()]]), { type: 'event' }, event].map(line => JSON.stringify(line)).join('\n') + '\n';
}
