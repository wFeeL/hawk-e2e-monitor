import { createCollectorClient } from '../../clients/collector.js';
import type { CollectorClient } from '../../clients/collector.js';
import { scenarioSettings } from '../../config/scenario.js';
import type { RunResult } from '../../engine/result.js';
import { CheckError } from '../../errors/taxonomy.js';
import { collectorEndpoints, decodeIntegrationToken } from '../../hawk/token.js';
import type { CreatedProjects } from '../../storage/created-projects.js';
import type { PendingProjects } from '../../storage/pending-projects.js';
import { NEW_PROJECT } from '../names.js';
import { buildRunResult, runSteps, stageWarnings } from '../run-steps.js';
import { planRun } from '../shared/plan.js';
import type { PlanOptions } from '../shared/plan.js';
import type { ScenarioDeps } from '../send-and-receive/run.js';
import { apiAvailabilityStage, eventVisibleStage } from '../send-and-receive/stages.js';
import type { ScenarioState } from '../send-and-receive/stages.js';
import { decideVerdict } from '../shared/verdict.js';
import { TOKEN_POLL_MS, cleanupProjectStage, newProjectShape, projectCreatedStage, tokenAcceptedStage } from './stages.js';
import type { NewProjectContext } from './stages.js';

/** Everything `runNewProject` needs from outside. */
export interface NewProjectDeps extends ScenarioDeps {
  /** Record of the projects that were created and not removed yet, which the sweep reads. */
  projects: CreatedProjects;
  /** Record of the runs whose project may exist without a known id, which the sweep looks for by name. */
  pending: PendingProjects;
  /** Adds a value that output must not show, such as the new token. */
  addSecret: (value: string) => void;
  /** Builds the collector client for the token of the new project; reads the address from the token by default. */
  makeCollector?: (token: string) => CollectorClient;
  /** Time between two sends while the collector may not know the token, for tests. */
  tokenPollMs?: number;
}

/** The context of a run with the plan it was built from. */
export interface NewProjectRun {
  /** Context of the stages. */
  context: NewProjectContext;
  /** Decisions made before the run. */
  plan: ReturnType<typeof planRun>;
}

/**
 * Builds the collector client of the new project from its own token.
 * @param deps Configuration, clock and retry policy.
 * @returns Function that builds a client for a token.
 */
function defaultCollectorFactory(deps: ScenarioDeps): (token: string) => CollectorClient {
  return (token) => {
    const decoded = decodeIntegrationToken(token);

    if (decoded === undefined) {
      throw new CheckError('monitor_internal', { detail: 'Hawk gave a token for the new project that does not decode' });
    }

    return createCollectorClient({ endpoints: collectorEndpoints(decoded, deps.config.hawk.collectorUrl),
      httpTimeoutMs: deps.config.httpTimeoutMs,
      clock: deps.clock,
      retry: deps.config.retry });
  };
}

/**
 * Builds the context of a run.
 * @param deps Clients, record and masking.
 * @param options Run number and overrides; the event goes over HTTP once, whatever the options say.
 * @returns Context and plan.
 */
export function createNewProjectContext(deps: NewProjectDeps, options: PlanOptions): NewProjectRun {
  const { config, clock } = deps;
  const plan = planRun(config, { ...options,
    transport: 'http',
    repeat: false }, NEW_PROJECT, deps.randomLetters);
  const state: ScenarioState = { sendMayHaveReached: false };
  const context: NewProjectContext = { config,
    plan,
    collector: deps.collector,
    api: deps.api,
    clock,
    state,
    pollScheduleMs: deps.pollScheduleMs,
    projects: deps.projects,
    pending: deps.pending,
    logger: deps.logger,
    addSecret: deps.addSecret,
    makeCollector: deps.makeCollector ?? defaultCollectorFactory(deps),
    tokenPollMs: deps.tokenPollMs ?? TOKEN_POLL_MS };

  context.eventShape = newProjectShape(context);

  return { context,
    plan };
}

/**
 * Runs the scenario once: creates a project, waits until its token is accepted, finds the event in it, removes the project.
 * @param deps Configuration, clients, record, clock, logger and redactor.
 * @param options Run number and overrides.
 * @returns Result with secrets masked; never rejects for failures of Hawk.
 */
export async function runNewProject(deps: NewProjectDeps, options: PlanOptions): Promise<RunResult> {
  const { config, clock } = deps;
  const { timeouts } = config;
  const { context, plan } = createNewProjectContext(deps, options);
  const settings = scenarioSettings(config, NEW_PROJECT);
  const outcome = await runSteps({ context,
    clock,
    runTimeoutMs: settings.watchdogMs - settings.cleanupMs - config.monitoring.watchdogGraceMs,
    ...deps.signal === undefined ? {} : { signal: deps.signal },
    steps: [
      [apiAvailabilityStage(timeouts.apiAvailability)],
      [projectCreatedStage(timeouts.apiAvailability)],
      [tokenAcceptedStage(config.scenarios.newProject.tokenTimeoutMs)],
      [eventVisibleStage(timeouts.eventVisible)],
    ],
    cleanup: cleanupProjectStage(timeouts.cleanup) });

  return buildRunResult({ scenario: NEW_PROJECT,
    plan,
    instanceId: config.instanceId,
    outcome,
    clock,
    verdict: decideVerdict(outcome.stages, context.state),
    warnings: stageWarnings(outcome.stages),
    state: context.state,
    redact: deps.redact,
    logger: deps.logger });
}
