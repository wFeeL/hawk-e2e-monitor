import { createTelegramClient } from '../../clients/telegram.js';
import type { TelegramClient } from '../../clients/telegram.js';
import { sendProbe } from '../../clients/codex-notify.js';
import { notificationSettings, telegramSettings } from '../../config/load.js';
import { scenarioSettings } from '../../config/scenario.js';
import type { RunResult } from '../../engine/result.js';
import { resolvePublicAddress } from '../../notifications/address.js';
import { createProvisioner } from '../../notifications/provisioning.js';
import { notificationBeforeSend, notificationSetupStage } from '../check-notification/stages.js';
import type { NotificationDeps } from '../check-notification/run.js';
import type { NotificationState } from '../check-notification/stages.js';
import { TELEGRAM_DELIVERY } from '../names.js';
import { buildRunResult, runSteps } from '../run-steps.js';
import { planRun } from '../send-and-receive/plan.js';
import type { PlanOptions } from '../send-and-receive/plan.js';
import { apiAvailabilityStage, cleanupStage, collectorAcceptStage, collectorAvailabilityStage, eventVisibleStage } from '../send-and-receive/stages.js';
import type { ScenarioState } from '../send-and-receive/stages.js';
import { telegramDeliveredStage, telegramFormedStage, telegramProbeStage, telegramReadyStage } from './stages.js';
import type { TelegramContext, TelegramState } from './stages.js';
import { decideTelegramVerdict } from './verdict.js';

/** Everything `runTelegramDelivery` needs from outside. */
export interface TelegramDeliveryDeps extends NotificationDeps {
  /** Client of the Bot API; built from the configuration by default. */
  telegramClient?: TelegramClient;
  /** Sends the probe through @codex_bot; the real client by default. */
  sendProbe?: typeof sendProbe;
}

/**
 * Runs the scenario once: the bot is checked and drained, the event is sent, and the webhook of rule T, the event and the Telegram message are awaited together.
 * The probe step runs only when the message did not come although the webhook did.
 * @param deps Configuration, clients, receiver, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk or Telegram.
 * @throws ConfigFailure when the token or the notify address of the bot is missing or malformed.
 */
export async function runTelegramDelivery(deps: TelegramDeliveryDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock, receiver } = deps;
  const { timeouts } = config;
  const settings = notificationSettings(config);
  const bot = telegramSettings(config);
  const plan = planRun(config, { ...options,
    repeat: false }, TELEGRAM_DELIVERY, deps.randomLetters);
  const provisioner = deps.provisioner ?? createProvisioner({ api: deps.api,
    clock,
    projectId: config.hawk.projectId,
    instanceId: config.instanceId,
    secret: settings.receiverSecret,
    loop: false,
    kinds: ['telegram'],
    notifyUrl: bot.notifyUrl,
    warmupMs: settings.ruleCacheWarmupMs,
    ...deps.lastMatchChangeAtWallMs === undefined ? {} : { lastMatchChangeAtWallMs: deps.lastMatchChangeAtWallMs },
    ...deps.onMatchChange === undefined ? {} : { onMatchChange: deps.onMatchChange } });
  const state: ScenarioState = { sendMayHaveReached: false };
  const notification: NotificationState = { warmup: false };
  const telegram: TelegramState = { offset: 0,
    polls: 0,
    unmatched: 0 };
  const context: TelegramContext = { config,
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
    notification,
    telegramClient: deps.telegramClient ?? createTelegramClient({ apiUrl: bot.apiUrl,
      token: bot.botToken,
      httpTimeoutMs: config.httpTimeoutMs,
      clock }),
    sendProbe: deps.sendProbe ?? sendProbe,
    telegram };
  const limits = scenarioSettings(config, TELEGRAM_DELIVERY);
  const http = config.httpTimeoutMs;
  let outcome;

  try {
    outcome = await runSteps({ context,
      clock,
      runTimeoutMs: limits.watchdogMs - limits.cleanupMs - config.monitoring.watchdogGraceMs,
      ...deps.signal === undefined ? {} : { signal: deps.signal },
      steps: [
        [collectorAvailabilityStage(timeouts.collectorAvailability)],
        [apiAvailabilityStage(timeouts.apiAvailability, { title: plan.title })],
        [telegramReadyStage(timeouts.apiAvailability)],
        [notificationSetupStage(settings.setupTimeoutMs)],
        [collectorAcceptStage(timeouts.collectorAccept, notificationBeforeSend(context))],
        [eventVisibleStage(timeouts.eventVisible),
          telegramFormedStage(settings.timeoutMs + http),
          telegramDeliveredStage(bot.deliveryTimeoutMs + 2 * http)],
        [telegramProbeStage(http + bot.probeTimeoutMs + 2 * http)],
      ],
      // A failed send that may have reached the collector still needs the search and the cleanup.
      keepGoing: failed => failed.name === 'collector_accept' && state.sendMayHaveReached,
      cleanup: cleanupStage(timeouts.cleanup) });

    // What arrived after the wait of the stage, such as a second POST, counts for the verdict.
    notification.finalArrivals = receiver.counts(plan.runId);
  } finally {
    receiver.release(plan.runId);
  }

  const decided = decideTelegramVerdict(outcome.stages, state, notification, telegram, config.hawk.projectId);
  const { provisioning } = notification;

  return buildRunResult({ scenario: TELEGRAM_DELIVERY,
    plan,
    instanceId: config.instanceId,
    outcome,
    clock,
    verdict: decided.verdict,
    warnings: decided.warnings,
    state,
    redact: deps.redact,
    logger: deps.logger,
    extra: { ...decided.notification === undefined ? {} : { notification: decided.notification },
      ...provisioning === undefined
        ? {}
        : { provisioning: { action: provisioning.action,
            deleted: provisioning.deleted,
            matchChanged: provisioning.matchChanged } },
      ...decided.telegram === undefined ? {} : { telegram: decided.telegram } } });
}
