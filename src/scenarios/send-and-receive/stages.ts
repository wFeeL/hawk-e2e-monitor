import type { CollectorClient, CollectorMessage, SendOutcome } from '../../clients/collector.js';
import type { FoundEvent, HawkApi } from '../../clients/hawk-api.js';
import type { Config } from '../../config/load.js';
import type { PollResult } from '../../engine/poll.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Clock } from '../../time/clock.js';
import type { RunPlan } from './plan.js';

const LOW_QUOTA_SHARE = 0.1;

/** What the stages learn on the way and hand to later stages and the verdict. */
export interface ScenarioState {
  /** Outcome of the first send. */
  sendOutcome?: SendOutcome;
  /** True when the event may have reached the collector although no answer confirmed it. */
  sendMayHaveReached: boolean;
  /** Monotonic time of the collector's answer, or of the start of the send when it is uncertain. */
  acceptedAtMs?: number;
  /** The event found in Hawk. */
  event?: FoundEvent;
  /** Time from `acceptedAtMs` to the first sighting. */
  latencyMs?: number;
  /** How the poll of stage 4 ended. */
  pollSummary?: PollResult<FoundEvent>;
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
}

/**
 * Builds the message of the test event.
 * @param context Scenario context.
 * @returns Message for the collector client.
 */
export function eventMessage(context: ScenarioContext): CollectorMessage {
  const { plan, config } = context;

  return { token: config.hawk.integrationToken,
    catcherType: plan.catcherType,
    payload: { title: plan.title,
      type: 'e2e-check',
      context: plan.context } };
}

/**
 * Stage 1: the collector answers `/health` and rejects an unknown token over WebSocket.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAvailabilityStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'collector_availability',
    budgetMs,
    run: async ({ collector }, signal) => {
      await collector.health(signal);
      await collector.probeInvalidToken(signal);

      return { status: 'ok' };
    },
  };
}

/**
 * Stage 2: the monitor can sign in, the token belongs to the project and the workspace has quota.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function apiAvailabilityStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'api_availability',
    budgetMs,
    run: async ({ api, config }, signal): Promise<StageOutcome> => {
      const { projectId, integrationToken } = config.hawk;

      await api.ensureSession(signal);

      const hawkToken = decodeIntegrationToken(await api.projectToken(projectId, signal));
      const ownToken = decodeIntegrationToken(integrationToken);

      if (hawkToken === undefined || ownToken === undefined || tokenKey(hawkToken) !== tokenKey(ownToken)) {
        throw new CheckError('token_mismatch');
      }

      const quota = await api.workspaceQuota(projectId, signal);
      const usage = `${String(quota.eventsCount)}/${String(quota.eventsLimit)}`;

      if (quota.isBlocked) {
        throw new CheckError('workspace_blocked', { detail: usage });
      }

      if (quota.eventsCount >= quota.eventsLimit) {
        throw new CheckError('quota_exhausted', { detail: usage });
      }

      const left = (quota.eventsLimit - quota.eventsCount) / quota.eventsLimit;

      return left < LOW_QUOTA_SHARE
        ? { status: 'ok',
            details: { warning: `Event quota is almost used: ${usage}` } }
        : { status: 'ok' };
    },
  };
}

/**
 * Stage 3: sends the event over the planned transport.
 * @param budgetMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAcceptStage(budgetMs: number): StageSpec<ScenarioContext> {
  return {
    name: 'collector_accept',
    budgetMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { collector, clock, plan, state } = context;
      const startedMs = clock.monotonicMs();
      const outcome = await collector.send(eventMessage(context), plan.transport, signal);

      state.sendOutcome = outcome;

      switch (outcome.kind) {
        case 'accepted':
          state.acceptedAtMs = clock.monotonicMs();

          return { status: 'ok',
            details: { attempts: outcome.attempts } };
        case 'uncertain':
          state.sendMayHaveReached = true;
          state.acceptedAtMs = startedMs;

          return { status: 'uncertain',
            error: outcome.cause,
            details: { attempts: outcome.attempts } };
        case 'rejected':
          return { status: 'failed',
            error: outcome.error,
            details: { attempts: outcome.attempts } };
      }
    },
  };
}
