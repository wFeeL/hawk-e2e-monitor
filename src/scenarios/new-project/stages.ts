import type { CollectorClient, CollectorMessage } from '../../clients/collector.js';
import type { CreatedProject } from '../../clients/hawk-api.js';
import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError, isCheckError } from '../../errors/taxonomy.js';
import type { ErrorClass } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { Logger } from '../../log/logger.js';
import type { CreatedProjects } from '../../storage/created-projects.js';
import type { PendingProjects } from '../../storage/pending-projects.js';
import { eventMessage, sendEventShape } from '../shared/event.js';
import type { EventShape } from '../shared/event.js';
import type { ScenarioContext } from '../shared/context.js';

const REFUSED = 'ECONNREFUSED';
const MAY_EXIST_WARNING = 'The project of this run may still be created in Hawk; the sweep removes it';
// Errors that say the request was refused or never left the machine, so no project was made.
const NOTHING_MADE: readonly ErrorClass[] = ['dns_error', 'api_query_rejected', 'api_auth_failed', 'api_forbidden'];
const NO_PROJECT_TEXT = 'There is no project with that id';

/** Time between two sends while the collector may not know the new token yet. */
export const TOKEN_POLL_MS = 10_000;

/** The project the run created. */
export interface CreatedProjectState {
  /** 24-character hex id. */
  id: string;
  /** Integration token. */
  token: string;
}

/** Everything the stages of `new-project` need. */
export interface NewProjectContext extends ScenarioContext {
  /** Record of the projects that were created and not removed yet. */
  projects: Pick<CreatedProjects, 'forget' | 'record'>;
  /** Record of the runs whose project may exist without a known id. */
  pending: Pick<PendingProjects, 'add' | 'drop'>;
  /** Log of the run. */
  logger: Logger;
  /** Adds a value that output must not show. */
  addSecret: (value: string) => void;
  /** Builds the client of the collector that serves the token of the new project. */
  makeCollector: (token: string) => CollectorClient;
  /** Time between two sends of the event, 10 s by default. */
  tokenPollMs: number;
  /** The project, once `project_created` has made it. */
  created?: CreatedProjectState;
  /** Monotonic time at which the project was created. */
  createdAtMs?: number;
}

/**
 * Builds the shape of the event of the run: the monitor's usual event, sent with the token of the new project and looked for in it.
 * @param context Context whose created project the shape follows.
 * @returns Shape of the event.
 */
export function newProjectShape(context: NewProjectContext): EventShape {
  const base = sendEventShape(context);

  return { ...base,
    get projectId(): string {
      return context.created?.id ?? '';
    },
    message: (ctx): CollectorMessage => ({ ...eventMessage(ctx),
      token: context.created?.token ?? '' }) };
}

/**
 * Finds a project by its name, for a create that may have worked although its answer was lost.
 * @param context Context with the API.
 * @param workspaceId Workspace the project was created in.
 * @param name Name given to the project.
 * @param signal Deadline of the stage.
 * @returns The project, undefined when there is none.
 */
async function findCreated(context: NewProjectContext, workspaceId: string, name: string, signal: AbortSignal): Promise<CreatedProject | undefined> {
  const { api } = context;
  const lists = await api.workspaceProjects([], signal);
  const found = lists.find(list => list.workspaceId === workspaceId)?.projects.find(project => project.name === name);

  return found === undefined
    ? undefined
    : { id: found.id,
        token: (await api.projectInfo(found.id, signal)).token };
}

/**
 * Stage `project_created`: creates the project in the workspace of the monitored one and learns its token.
 * The id goes into the record and the token into the masking before anything is sent.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function projectCreatedStage(timeoutMs: number): StageSpec<NewProjectContext> {
  return {
    name: 'project_created',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, clock, config, logger, pending, plan, projects } = context;

      await api.ensureSession(signal);

      const { workspaceId } = await api.workspaceQuota(config.hawk.projectId, signal);
      const name = `[e2e:${config.instanceId}] new-project ${plan.runId}`;
      let created: CreatedProject | undefined;

      // Written before the request: an answer that is lost leaves the sweep a name to look for.
      pending.add(plan.runId, clock.wallTime().toISOString());

      try {
        created = await api.createProject(workspaceId, name, signal);
      } catch (error) {
        if (isCheckError(error) && (NOTHING_MADE.includes(error.errorClass) || error.facts.code === REFUSED)) {
          pending.drop(plan.runId);

          throw error;
        }

        if (!isCheckError(error)) {
          throw error;
        }

        // Even a failure that looks final may have made the project, so the name is looked up.
        try {
          created = await findCreated(context, workspaceId, name, signal);
        } catch (lookupError) {
          logger.warn('could not look for the created project', { error: lookupError instanceof Error ? lookupError.message : String(lookupError) });
        }

        if (created === undefined) {
          return { status: 'failed',
            error,
            details: { warning: MAY_EXIST_WARNING } };
        }
      }

      const decoded = decodeIntegrationToken(created.token);

      context.addSecret(created.token);

      if (decoded !== undefined) {
        context.addSecret(decoded.secret);
        context.addSecret(tokenKey(decoded));
      }

      context.created = { id: created.id,
        token: created.token };
      context.createdAtMs = clock.monotonicMs();
      projects.record(created.id);
      pending.drop(plan.runId);

      return { status: 'ok',
        details: { projectId: created.id } };
    },
  };
}

/**
 * Stage `token_accepted`: sends the event with the token of the new project every few seconds until the collector takes it.
 * The collector reloads tokens on a timer, so «Integration token invalid» means «not yet»; any other answer ends the wait.
 * @param timeoutMs Time the collector may take to know the token.
 * @returns Stage spec.
 */
export function tokenAcceptedStage(timeoutMs: number): StageSpec<NewProjectContext> {
  return {
    name: 'token_accepted',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { clock, created, createdAtMs, plan, state } = context;

      if (created === undefined || createdAtMs === undefined) {
        throw new CheckError('monitor_internal', { detail: 'token_accepted ran without a created project' });
      }

      const collector = context.makeCollector(created.token);
      const message = newProjectShape(context).message(context);
      let attempts = 0;
      let last: CheckError | undefined;

      for (;;) {
        attempts += 1;

        const startedMs = clock.monotonicMs();
        const outcome = await collector.send(message, plan.transport, signal);

        state.sendOutcome = outcome;

        if (outcome.kind === 'accepted') {
          state.acceptedAtMs = clock.monotonicMs();

          return { status: 'ok',
            details: { attempts,
              tokenAcceptedAfterMs: Math.round(clock.monotonicMs() - createdAtMs) } };
        }

        const timedOut = (): StageOutcome => ({ status: 'failed',
          error: new CheckError('new_token_not_accepted', { waitedMs: Math.round(clock.monotonicMs() - createdAtMs),
            ...last?.facts.detail === undefined ? {} : { detail: last.facts.detail } }),
          details: { attempts } });

        if (signal.aborted) {
          return timedOut();
        }

        if (outcome.kind === 'uncertain') {
          state.sendMayHaveReached = true;
          state.acceptedAtMs = startedMs;

          return { status: 'failed',
            error: outcome.cause,
            details: { attempts } };
        }

        if (outcome.error.errorClass !== 'auth_invalid_token') {
          return { status: 'failed',
            error: outcome.error,
            details: { attempts } };
        }

        last = outcome.error;

        try {
          await clock.sleep(context.tokenPollMs, signal);
        } catch {
          return timedOut();
        }
      }
    },
  };
}

/**
 * Stage `cleanup`: removes the project the run created, and only that one.
 * A project that is already gone counts as removed.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function cleanupProjectStage(timeoutMs: number): StageSpec<NewProjectContext> {
  return {
    name: 'cleanup',
    timeoutMs,
    run: async (context, signal): Promise<StageOutcome> => {
      const { api, config, created, projects } = context;

      if (created === undefined) {
        return { status: 'skipped' };
      }

      if (created.id === config.hawk.projectId) {
        throw new CheckError('cleanup_refused', { detail: created.id }, { message: `Removal cancelled: project ${created.id} is the monitored one` });
      }

      let removed: boolean;

      try {
        removed = await api.removeProject(created.id, signal);
      } catch (error) {
        if (isCheckError(error) && (error.facts.detail ?? '').includes(NO_PROJECT_TEXT)) {
          projects.forget(created.id);

          return { status: 'ok' };
        }

        if (isCheckError(error)) {
          return { status: 'failed',
            error: new CheckError('cleanup_failed', { detail: error.message }, { cause: error }) };
        }

        throw error;
      }

      if (!removed) {
        return { status: 'failed',
          error: new CheckError('cleanup_failed', { detail: 'Hawk answered that nothing was removed' }) };
      }

      projects.forget(created.id);

      return { status: 'ok' };
    },
  };
}
