import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { Clock } from '../../time/clock.js';
import type { AvailabilityContext } from '../send-and-receive/stages.js';
import { checkGarage } from '../../clients/garage.js';

/** Everything a stage of the probe needs. */
export interface ProbeContext extends AvailabilityContext {
  /** Time source. */
  clock: Clock;
}

/**
 * Stage `garage_availability`: Garage serves its index page and the start of its script bundle.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec; it fails with `monitor_internal` when no Garage address is configured, so the runner adds it only with one.
 */
export function garageAvailabilityStage(timeoutMs: number): StageSpec<ProbeContext> {
  return {
    name: 'garage_availability',
    timeoutMs,
    run: async ({ config, clock }, signal): Promise<StageOutcome> => {
      const origin = config.hawk.garageUrl;

      if (origin === undefined) {
        throw new CheckError('monitor_internal', { stage: 'garage_availability',
          detail: 'GARAGE_URL is not set' });
      }

      const checked = await checkGarage(origin, { httpTimeoutMs: config.httpTimeoutMs,
        clock,
        retry: config.retry }, signal);

      return { status: 'ok',
        details: { ...checked } };
    },
  };
}
