import type { CollectorClient, SendOutcome } from '../../clients/collector.js';
import type { FoundEvent, HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import type { Clock } from '../../time/clock.js';
import type { RunPlan } from './plan.js';
import type { EventShape } from './event.js';

/** What the stages learn on the way and hand to later stages and the verdict. */
export interface ScenarioState {
  /** Outcome of the first send. */
  sendOutcome?: SendOutcome;
  /** True when the event may have reached the collector although no answer confirmed it. */
  sendMayHaveReached: boolean;
  /** Monotonic time of the collector's answer, or of the start of the send when it is uncertain. */
  acceptedAtMs?: number;
  /** Monotonic time of the collector's answer to the second send, or of the start of that send when it is uncertain. */
  repeatAcceptedAtMs?: number;
  /** The event found in Hawk. */
  event?: FoundEvent;
  /** Time from `acceptedAtMs` to the first sighting. */
  latencyMs?: number;
}

/** Everything a stage needs. */
export interface ScenarioContext {
  /** Validated configuration. */
  config: Config;
  /** Decisions made before the run. */
  plan: RunPlan;
  /** Collector client. */
  collector: CollectorClient;
  /** Hawk API client. */
  api: HawkApi;
  /** Time source. */
  clock: Clock;
  /** Shared state of the run. */
  state: ScenarioState;
  /** Poll schedule override, for tests. */
  pollScheduleMs?: readonly number[];
  /** What the event of the scenario looks like; the event of `send-and-receive-event` when absent. */
  eventShape?: EventShape;
}

/** What the two availability stages need, so a scenario without an event can run them too. */
export type AvailabilityContext = Pick<ScenarioContext, 'api' | 'collector' | 'config'>;
