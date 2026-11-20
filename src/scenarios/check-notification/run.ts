import { runStage, runStageGroup, skippedStage } from '../../engine/stages.js';
import type { StageSpec } from '../../engine/stages.js';
import type { RunResult, StageResult } from '../../engine/result.js';
import { redactDeep } from '../../errors/redact.js';
import { notificationSettings } from '../../config/load.js';
import { readTunnelRegistrations, resolvePublicAddress } from '../../notifications/address.js';
import type { PublicAddress } from '../../notifications/address.js';
import { createProvisioner } from '../../notifications/provisioning.js';
import type { Provisioner } from '../../notifications/provisioning.js';
import type { Receiver } from '../../receiver/server.js';
import { planRun } from '../shared/plan.js';
import type { PlanOptions } from '../shared/plan.js';
import { abortedStage, followOutsideSignal, toCleanupResult } from '../run-steps.js';
import type { ScenarioDeps } from '../shared/deps.js';
import { apiAvailabilityStage, collectorAvailabilityStage } from '../shared/availability.js';
import { cleanupStage } from '../shared/cleanup.js';
import { collectorAcceptStage, eventRepeatedStage, eventVisibleStage } from '../shared/delivery.js';
import type { ScenarioState } from '../shared/context.js';
import { notificationBeforeSend, notificationFormedStage, notificationSetupStage, thresholdBeforeRepeat, thresholdFormedStage } from './stages.js';
import type { LastHostname, NotificationContext, NotificationState } from './stages.js';
import { decideNotificationVerdict } from './verdict.js';
import { CHECK_NOTIFICATION } from '../names.js';

/** Everything `runCheckNotification` needs from outside. */
export interface NotificationDeps extends ScenarioDeps {
  /** Receiver that is already listening; the caller owns it. */
  receiver: Receiver;
  /** Keeps the notification rule right; built from the configuration by default. */
  provisioner?: Provisioner;
  /** Reads the registration counter of the tunnel; built from the settings by default, for tests. */
  tunnelRegistrations?: (signal: AbortSignal) => Promise<number | undefined>;
  /** Finds the public address; reads the settings by default. */
  resolveAddress?: (signal: AbortSignal) => Promise<PublicAddress>;
  /** Wall-clock time of the last change of the rule matching, read by a one-off command; absent when unknown. */
  lastMatchChangeAtWallMs?: number;
  /** Called with the wall-clock time when the run changes the rule matching. */
  onMatchChange?: (wallMs: number) => void;
  /** Adds a value that output must not show, such as the public address. */
  addSecret: (value: string) => void;
  /** Host of the previous run's address, shared by the runs of a process; see `NotificationContext`. */
  lastHostname?: LastHostname;
  /** Pause between self-checks while waiting for a new address, for tests. */
  addressPollMs?: number;
}

type Step = Array<StageSpec<NotificationContext>>;

/**
 * Finds how the stages read the registration counter of the tunnel.
 * @param deps Dependencies of the run.
 * @param settings Notification settings; the counter is read only when the address comes from the tunnel.
 * @returns The reader, or undefined when the address is fixed or the metrics address is unknown.
 */
export function registrationsReader(deps: NotificationDeps, settings: ReturnType<typeof notificationSettings>): NotificationContext['tunnelRegistrations'] {
  if (deps.tunnelRegistrations !== undefined) {
    return deps.tunnelRegistrations;
  }

  const metricsUrl = settings.tunnelMetricsUrl;

  if (settings.publicBaseUrl !== undefined || metricsUrl === undefined) {
    return undefined;
  }

  const { config, clock } = deps;

  return async signal => readTunnelRegistrations(metricsUrl, { httpTimeoutMs: config.httpTimeoutMs,
    clock,
    retry: config.retry }, signal);
}

/**
 * Runs the scenario once: stages in order with `event_visible` and `notification_formed` in parallel, then cleanup.
 * @param deps Configuration, clients, receiver, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runCheckNotification(deps: NotificationDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock, receiver } = deps;
  const { timeouts } = config;
  const settings = notificationSettings(config);
  const plan = planRun(config, options, CHECK_NOTIFICATION, deps.randomLetters);
  const provisioner = deps.provisioner ?? createProvisioner({ api: deps.api,
    clock,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    secret: settings.receiverSecret,
    loop: settings.loop,
    warmupMs: settings.ruleCacheWarmupMs,
    ...deps.lastMatchChangeAtWallMs === undefined ? {} : { lastMatchChangeAtWallMs: deps.lastMatchChangeAtWallMs },
    ...deps.onMatchChange === undefined ? {} : { onMatchChange: deps.onMatchChange } });
  const tunnelRegistrations = registrationsReader(deps, settings);
  const state: ScenarioState = { sendMayHaveReached: false };
  const notification: NotificationState = { warmup: false };
  const context: NotificationContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs,
    receiver,
    provisioner,
    settings,
    resolveAddress: deps.resolveAddress ?? (async signal => resolvePublicAddress(settings, { httpTimeoutMs: config.httpTimeoutMs,
      clock,
      retry: config.retry }, signal)),
    addSecret: deps.addSecret,
    ...deps.lastHostname === undefined ? {} : { lastHostname: deps.lastHostname },
    ...deps.addressPollMs === undefined ? {} : { addressPollMs: deps.addressPollMs },
    ...tunnelRegistrations === undefined ? {} : { tunnelRegistrations },
    notification };
  const startedAt = clock.wallTime().toISOString();
  const t0 = clock.monotonicMs();
  const run = new AbortController();
  const timer = new AbortController();
  const unfollow = followOutsideSignal(run, deps.signal);

  clock.sleep(timeouts.run, timer.signal).then(() => {
    run.abort();
  }, () => undefined);

  const steps: Step[] = [
    [collectorAvailabilityStage(timeouts.collectorAvailability)],
    [apiAvailabilityStage(timeouts.apiAvailability, { title: plan.title })],
    [notificationSetupStage(settings.setupTimeoutMs)],
    [collectorAcceptStage(timeouts.collectorAccept, notificationBeforeSend(context))],
    [eventVisibleStage(timeouts.eventVisible), notificationFormedStage(settings.timeoutMs + 2 * config.httpTimeoutMs)],
    [eventRepeatedStage(timeouts.eventRepeated, thresholdBeforeRepeat(context))],
    [thresholdFormedStage(settings.timeoutMs + 2 * config.httpTimeoutMs)],
  ];
  const stages: StageResult[] = [];

  try {
    let skipRest = false;

    for (const step of steps) {
      if (skipRest) {
        stages.push(...step.map(spec => skippedStage(spec.name, clock)));
      } else if (run.signal.aborted) {
        stages.push(...step.map(spec => abortedStage(spec.name, clock, run.signal)));
        skipRest = true;
      } else {
        const runner = { clock,
          runSignal: run.signal };
        const results = step.length === 1 && step[0] !== undefined
          ? [await runStage(step[0], context, runner)]
          : await runStageGroup(step, context, runner);
        const [first] = results;

        stages.push(...results);
        // A failed send that may have reached the collector still needs the search and the cleanup.
        // A failed notification does not stop the repeat; a failed search does.
        skipRest = first?.status === 'failed' && !(first.name === 'collector_accept' && state.sendMayHaveReached);
      }
    }

    timer.abort();
    unfollow();

    // Cleanup has its own timeout outside the run deadline, so its signal is never aborted by the run.
    stages.push(await runStage(cleanupStage(timeouts.cleanup), context, { clock,
      runSignal: new AbortController().signal }));

    if (stages.some(stage => stage.name === 'collector_accept' && stage.status !== 'skipped')) {
      notification.finalArrivals = receiver.counts(plan.runId);
    }
  } finally {
    timer.abort();
    unfollow();
    receiver.release(plan.runId);
  }

  const decided = decideNotificationVerdict(stages, state, notification, config.hawk.projectId, plan.repeat);
  const { verdict } = decided;
  const cleanupStageResult = stages.at(-1);
  const result: RunResult = {
    runId: plan.runId,
    scenario: plan.context.scenario,
    instanceId: config.instanceId,
    sequence: plan.sequence,
    transport: plan.transport,
    catcherType: plan.catcherType,
    title: plan.title,
    startedAt,
    finishedAt: clock.wallTime().toISOString(),
    durationMs: clock.monotonicMs() - t0,
    status: verdict.status,
    warnings: decided.warnings,
    sendMayHaveReached: state.sendMayHaveReached,
    stages,
    cleanup: cleanupStageResult ? toCleanupResult(cleanupStageResult) : { status: 'skipped' },
  };

  if (verdict.failedStage) {
    result.failedStage = verdict.failedStage;
  }

  if (verdict.error) {
    result.errorClass = verdict.error.errorClass;
    result.culprit = verdict.error.culprit;
    result.message = verdict.error.message;
  }

  if (state.event) {
    result.event = { originalEventId: state.event.originalEventId,
      groupHash: state.event.groupHash,
      totalCount: state.event.totalCount };
  }

  if (state.latencyMs !== undefined) {
    result.eventLatencyMs = state.latencyMs;
  }

  if (decided.notification) {
    result.notification = decided.notification;
  }

  if (notification.provisioning) {
    const { action, deleted, matchChanged } = notification.provisioning;

    result.provisioning = { action,
      deleted,
      matchChanged };
  }

  const redacted = redactDeep(result, deps.redact);

  deps.logger.info('run finished', { runId: redacted.runId,
    status: redacted.status,
    failedStage: redacted.failedStage });

  return redacted;
}
