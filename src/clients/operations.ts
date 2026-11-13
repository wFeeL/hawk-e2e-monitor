import type { GraphqlOperation } from './graphql.js';

/** Sign in with email and password. */
export const LOGIN: GraphqlOperation = {
  name: 'Login',
  document: 'mutation Login($email: String!, $password: String!) { login(email: $email, password: $password) { accessToken refreshToken } }',
  idempotent: true,
};

/** Swap a refresh token for a new pair; the old refresh token dies, so no blind retries. */
export const REFRESH_TOKENS: GraphqlOperation = {
  name: 'RefreshTokens',
  document: 'mutation RefreshTokens($refreshToken: String!) { refreshTokens(refreshToken: $refreshToken) { accessToken refreshToken } }',
  idempotent: false,
};

/** Integration token of a project. */
export const PROJECT_TOKEN: GraphqlOperation = {
  name: 'ProjectToken',
  document: 'query ProjectToken($projectId: ID!) { project(projectId: $projectId) { token } }',
  idempotent: true,
};

/** Workspace of a project with its plan limit and event counter. */
export const WORKSPACE_QUOTA: GraphqlOperation = {
  name: 'WorkspaceQuota',
  document: 'query WorkspaceQuota($projectId: ID!) { workspaces { id isBlocked billingPeriodEventsCount plan { eventsLimit } projects(ids: [$projectId]) { id } } }',
  idempotent: true,
};

/** Events of a project found by a search string. */
export const FIND_EVENTS: GraphqlOperation = {
  name: 'FindEvents',
  document: `query FindEvents($projectId: ID!, $search: String!) {
  project(projectId: $projectId) {
    dailyEventsPortion(limit: 50, search: $search) {
      dailyEvents { id count event { id originalEventId groupHash totalCount catcherType payload { title context } } }
    }
  }
}`,
  idempotent: true,
};

/** Card of one event by the id of its original event. */
export const EVENT_CARD: GraphqlOperation = {
  name: 'EventCard',
  document: `query EventCard($projectId: ID!, $eventId: ID!) {
  project(projectId: $projectId) {
    event(eventId: $eventId, originalEventId: $eventId) { id originalEventId groupHash totalCount catcherType payload { title context } }
  }
}`,
  idempotent: true,
};

/** Deletes an event; repeating it after an unknown outcome is decided by the caller. */
export const REMOVE_EVENT: GraphqlOperation = {
  name: 'RemoveEvent',
  document: 'mutation RemoveEvent($projectId: ID!, $eventId: ID!) { removeEvent(projectId: $projectId, eventId: $eventId) }',
  idempotent: false,
};

/** Every operation the monitor sends. */
export const ALL_OPERATIONS: readonly GraphqlOperation[] = [LOGIN, REFRESH_TOKENS, PROJECT_TOKEN, WORKSPACE_QUOTA, FIND_EVENTS, EVENT_CARD, REMOVE_EVENT];
