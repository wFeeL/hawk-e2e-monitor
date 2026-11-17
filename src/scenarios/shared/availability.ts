import type { StageOutcome, StageSpec } from '../../engine/stages.js';
import { CheckError } from '../../errors/taxonomy.js';
import { decodeIntegrationToken, tokenKey } from '../../hawk/token.js';
import type { DegradedCode } from '../../storage/types.js';
import type { AvailabilityContext } from './context.js';

const LOW_QUOTA_SHARE = 0.1;

/**
 * Stage 1: the collector answers `/health` and rejects an unknown token over WebSocket.
 * @param timeoutMs Time limit of the stage.
 * @returns Stage spec.
 */
export function collectorAvailabilityStage(timeoutMs: number): StageSpec<AvailabilityContext> {
  return {
    name: 'collector_availability',
    timeoutMs,
    run: async ({ collector }, signal) => {
      await collector.health(signal);
      await collector.probeInvalidToken(signal);

      return { status: 'ok' };
    },
  };
}

/** What `apiAvailabilityStage` may check besides the token and the quota. */
export interface ApiAvailabilityOptions {
  /** Title of the next event; a grouping pattern that catches it is reported. */
  title?: string;
}

/** What the grouping patterns of a project say about a title. */
interface PatternFindings {
  /** Texts for the result. */
  warnings: string[];
  /** Degradation codes the warnings stand for. */
  degraded: DegradedCode[];
}

/**
 * Names the grouping patterns that catch a title.
 * @param patterns Pattern texts of the project.
 * @param title Title of the next event.
 * @returns Warnings and the codes they stand for.
 */
function patternFindings(patterns: readonly string[], title: string): PatternFindings {
  const warnings: string[] = [];
  let catches = false;

  for (const pattern of patterns) {
    try {
      // Hawk compiles the patterns without the `u` flag, which accepts escapes such as `\:`.
      if (new RegExp(pattern).test(title)) {
        catches = true;
        warnings.push(`The event grouping pattern "${pattern}" of the project catches the title of the monitor's events, so Hawk may glue them together`);
      }
    } catch {
      warnings.push(`The event grouping pattern "${pattern}" of the project is not a regular expression the monitor can read`);
    }
  }

  return { warnings,
    degraded: catches ? ['grouping_pattern'] : [] };
}

/**
 * Stage 2: the monitor can sign in, the token belongs to the project, the workspace has quota and no grouping pattern catches the next title.
 * @param timeoutMs Time limit of the stage.
 * @param options Title of the next event, for the pattern check.
 * @returns Stage spec.
 */
export function apiAvailabilityStage(timeoutMs: number, options: ApiAvailabilityOptions = {}): StageSpec<AvailabilityContext> {
  return {
    name: 'api_availability',
    timeoutMs,
    run: async ({ api, config }, signal): Promise<StageOutcome> => {
      const { projectId, integrationToken } = config.hawk;

      await api.ensureSession(signal);

      const info = await api.projectInfo(projectId, signal);
      const hawkToken = decodeIntegrationToken(info.token);
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
      const findings = options.title === undefined
        ? { warnings: [],
            degraded: [] }
        : patternFindings(info.groupingPatterns, options.title);
      const details: Record<string, unknown> = { quota: { eventsCount: quota.eventsCount,
        eventsLimit: quota.eventsLimit } };

      if (left < LOW_QUOTA_SHARE) {
        details.warning = `Event quota is almost used: ${usage}`;
        details.quotaLow = true;
      }

      if (findings.warnings.length > 0) {
        details.warnings = findings.warnings;
      }

      if (findings.degraded.length > 0) {
        details.degraded = findings.degraded;
      }

      return { status: 'ok',
        details };
    },
  };
}
