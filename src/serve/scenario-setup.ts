import type { CollectorClient } from '../clients/collector.js';
import type { HawkApi } from '../clients/hawk-api.js';
import type { Config } from '../config/load.js';
import type { MutableRedactor } from '../errors/redact.js';
import type { Check } from '../http/internal-server.js';
import type { Logger } from '../log/logger.js';
import type { PublicAddress } from '../notifications/address.js';
import type { resolvePublicAddress } from '../notifications/address.js';
import type { ScenarioRunner } from '../scheduler/scheduler.js';
import type { History } from '../storage/history.js';
import type { Clock } from '../time/clock.js';

/** Something to stop when the service stops. */
export type Closer = () => Promise<void> | void;

/** Test replacements for the parts of a scenario that talk to the outside. */
export interface RunnerOverrides {
  /** Replaces the lookup of the public address. */
  resolveAddress?: typeof resolvePublicAddress;
  /** Poll schedule of the search for the event, short in tests. */
  pollScheduleMs?: readonly number[];
  /** Pause between self-checks while a new tunnel address is awaited, 2000 ms by default. */
  addressPollMs?: number;
  /** Pause between self-checks while the tunnel starts, 2000 ms by default. */
  tunnelPollMs?: number;
}

/** What a scenario needs to be set up. */
export interface RunnerContext {
  /** Validated configuration. */
  config: Config;
  /** History of the runs. */
  history: History;
  /** Time source and sleeper. */
  clock: Clock;
  /** Logger that masks secrets. */
  logger: Logger;
  /** Redactor that learns secrets while the process runs. */
  masking: MutableRedactor;
  /** Hawk API client shared by all runs. */
  api: HawkApi;
  /** Collector client shared by all runs. */
  collector: CollectorClient;
  /** Test replacements. */
  overrides: RunnerOverrides;
  /** Stops what a setup started; a setup adds its closers here as soon as it has started something. */
  closers: Closer[];
}

/** What one scenario brings to the service. */
export interface ScenarioSetup {
  /** Runs the scenario once. */
  runner: ScenarioRunner;
  /** Waited before the first run. */
  beforeFirstRun?: (signal: AbortSignal) => Promise<void>;
  /** Checks that join the readiness probe. */
  readiness?: Check[];
  /** Port of a listener the scenario started. */
  receiverPort?: number;
}

/** Sets one scenario up. */
export type SetupScenario = (context: RunnerContext) => Promise<ScenarioSetup>;

/** Address lookup the scenarios share. */
export type FindAddress = (signal: AbortSignal) => Promise<PublicAddress>;
