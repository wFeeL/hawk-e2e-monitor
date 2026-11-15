import { runStage, runStageGroup, skippedStage } from '../../engine/stages.js';
import type { StageSpec } from '../../engine/stages.js';
import type { RunResult, StageResult } from '../../engine/result.js';
import { redactDeep } from '../../errors/redact.js';
import { notificationSettings } from '../../config/load.js';
import { resolvePublicAddress } from '../../notifications/address.js';
import type { PublicAddress } from '../../notifications/address.js';
import { createProvisioner } from '../../notifications/provisioning.js';
import type { Provisioner } from '../../notifications/provisioning.js';
import type { Receiver } from '../../receiver/server.js';
import { planRun } from '../send-and-receive/plan.js';
import type { PlanOptions } from '../send-and-receive/plan.js';
import { abortedStage, followOutsideSignal, toCleanupResult } from '../send-and-receive/run.js';
import type { ScenarioDeps } from '../send-and-receive/run.js';
import { apiAvailabilityStage, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventRepeatedStage, eventVisibleStage } from '../send-and-receive/stages.js';
import type { ScenarioState } from '../send-and-receive/stages.js';
import { notificationBeforeSend, notificationFormedStage, notificationSetupStage } from './stages.js';
import type { LastHostname, NotificationContext, NotificationState } from './stages.js';
import { decideNotificationVerdict } from './verdict.js';
import { CHECK_NOTIFICATION } from '../names.js';

/** Everything `runCheckNotification` needs from outside. */
export interface NotificationDeps extends ScenarioDeps {
  /** Receiver that is already listening; the caller owns it. */
  receiver: Receiver;
  /** Keeps the notification rule right; built from the configuration by default. */
  provisioner?: Provisioner;
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
    [apiAvailabilityStage(timeouts.apiAvailability)],
    [notificationSetupStage(settings.setupTimeoutMs)],
    [collectorAcceptStage(timeouts.collectorAccept, notificationBeforeSend(context))],
    [eventVisibleStage(timeouts.eventVisible), notificationFormedStage(settings.timeoutMs + config.httpTimeoutMs)],
    [eventRepeatedStage(timeouts.eventRepeated)],
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

  const decided = decideNotificationVerdict(stages, state, notification, config.hawk.projectId);
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
