import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import type { PublicAddress } from '../../notifications/address.js';
import type { Clock } from '../../time/clock.js';
import type { AvailabilityContext } from '../shared/context.js';
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

/** What the stage `receiver_availability` needs from the running receiver. */
export interface ReceiverCheck {
  /** Finds the public address, one attempt. */
  findAddress: (signal: AbortSignal) => Promise<PublicAddress>;
  /** Probes the receiver through the address, one attempt. */
  probe: (address: PublicAddress, signal: AbortSignal) => Promise<void>;
  /** False until the first wait for the tunnel after startup has ended. */
  tunnelWaited: () => boolean;
  /** Adds a value that output must not show. */
  addSecret: (value: string) => void;
}

/**
 * Stage `receiver_availability`: the public address exists and the receiver answers through it.
 * It is skipped until the first wait for the tunnel has ended, so a restart does not look like a dead tunnel.
 * @param timeoutMs Time limit of the stage.
 * @param check The address lookup and the probe of the running receiver.
 * @returns Stage spec; a failure keeps the class of the lookup or the probe.
 */
export function receiverAvailabilityStage(timeoutMs: number, check: ReceiverCheck): StageSpec<ProbeContext> {
  return {
    name: 'receiver_availability',
    timeoutMs,
    run: async (_context, signal): Promise<StageOutcome> => {
      if (!check.tunnelWaited()) {
        return { status: 'skipped',
          details: { reason: 'tunnel_starting' } };
      }

      const address = await check.findAddress(signal);

      // The address is masked before the probe, whose failure text carries it.
      check.addSecret(address.baseUrl);
      check.addSecret(address.hostname);
      check.addSecret(new URL(address.baseUrl).hostname);
      await check.probe(address, signal);

      return { status: 'ok' };
    },
  };
}
