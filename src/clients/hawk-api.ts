import { CheckError, isCheckError } from '../errors/taxonomy.js';
import type { Clock } from '../time/clock.js';
import { GraphqlFailure } from './graphql.js';
import type { GraphqlOperation, GraphqlTransport } from './graphql.js';
import { LOGIN, PROJECT_TOKEN, REFRESH_TOKENS } from './operations.js';

const ACCESS_EXPIRED = 'ACCESS_TOKEN_EXPIRED_ERROR';
const UNAUTHENTICATED = 'UNAUTHENTICATED';

/** Accounts and waits the client needs. */
export interface HawkApiOptions {
  /** Sends GraphQL operations. */
  transport: GraphqlTransport;
  /** Email of the monitor account. */
  email: string;
  /** Password of the monitor account. */
  password: string;
  /** Clock for pauses between attempts. */
  clock: Clock;
  /** Pauses between attempts of a repeated call, `[200, 500]` by default. */
  retryDelaysMs?: readonly number[];
}

/** Calls of the Hawk API that the monitor makes. */
export interface HawkApi {
  /**
   * Signs in when there is no session yet.
   * @param signal Deadline of the caller.
   * @returns Resolves when tokens are held.
   * @throws CheckError `api_auth_failed` when Hawk rejects the account.
   */
  ensureSession(signal: AbortSignal): Promise<void>;
  /**
   * Reads the integration token of a project.
   * @param projectId 24-character hex id of the project.
   * @param signal Deadline of the caller.
   * @returns Integration token as Hawk stores it.
   */
  projectToken(projectId: string, signal: AbortSignal): Promise<string>;
}

/** Access and refresh tokens of the session. */
interface Session {
  /** Bearer token. */
  accessToken: string;
  /** Token that swaps for a new pair. */
  refreshToken: string;
}

/** Answer of the Login mutation. */
interface LoginData {
  /** The issued pair. */
  login: Session;
}

/** `data` of `RefreshTokens`. */
interface RefreshData {
  /** The issued pair. */
  refreshTokens: Session;
}

/** Answer of the ProjectToken query. */
interface ProjectTokenData {
  /** Null when the project is unknown. */
  project: ProjectTokenValue | null;
}

/** Token of a project. */
interface ProjectTokenValue {
  /** Integration token. */
  token: string;
}

/**
 * Creates the Hawk API client with an in-memory session.
 * @param options Transport and account.
 * @returns The client.
 */
export function createHawkApi(options: HawkApiOptions): HawkApi {
  const { transport, email, password } = options;
  let session: Session | undefined;

  const authFailed = (detail: string): CheckError => new CheckError('api_auth_failed', { detail });

  const login = async (signal: AbortSignal): Promise<void> => {
    try {
      const data = await transport.request<LoginData>(LOGIN, { email,
        password }, undefined, signal);

      session = data.login;
    } catch (error) {
      session = undefined;

      if (error instanceof GraphqlFailure) {
        throw authFailed(error.message);
      }

      if (isCheckError(error) && error.errorClass === 'api_query_rejected') {
        throw authFailed(error.facts.detail ?? error.message);
      }

      throw error;
    }
  };

  const refresh = async (current: Session, signal: AbortSignal): Promise<void> => {
    try {
      const data = await transport.request<RefreshData>(REFRESH_TOKENS, { refreshToken: current.refreshToken }, undefined, signal);

      session = data.refreshTokens;
    } catch (error) {
      if (error instanceof GraphqlFailure) {
        await login(signal);

        return;
      }

      throw error;
    }
  };

  const ensureSession = async (signal: AbortSignal): Promise<void> => {
    if (!session) {
      await login(signal);
    }
  };

  const call = async <T>(operation: GraphqlOperation, variables: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<T> => {
    await ensureSession(signal);

    return transport.request<T>(operation, variables, session?.accessToken, signal);
  };

  const authorized = async <T>(operation: GraphqlOperation, variables: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<T> => {
    try {
      return await call<T>(operation, variables, signal);
    } catch (error) {
      if (!(error instanceof GraphqlFailure)) {
        throw error;
      }

      if (error.code === ACCESS_EXPIRED && session) {
        await refresh(session, signal);
      } else if (error.code === UNAUTHENTICATED || error.code === ACCESS_EXPIRED) {
        await login(signal);
      } else {
        throw authFailed(error.message);
      }
    }

    try {
      return await call<T>(operation, variables, signal);
    } catch (error) {
      throw error instanceof GraphqlFailure ? authFailed(error.message) : error;
    }
  };

  return {
    ensureSession,
    async projectToken(projectId, signal) {
      const data = await authorized<ProjectTokenData>(PROJECT_TOKEN, { projectId }, signal);

      if (!data.project) {
        throw new CheckError('api_error', { detail: 'project not found' });
      }

      return data.project.token;
    },
  };
}
