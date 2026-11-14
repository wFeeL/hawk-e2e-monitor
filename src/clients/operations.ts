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

/** Notification rules of a project with all channel settings. */
export const NOTIFICATION_RULES: GraphqlOperation = {
  name: 'NotificationRules',
  document: `query NotificationRules($projectId: ID!) {
  project(projectId: $projectId) {
    id
    notifications {
      id isEnabled whatToReceive including excluding threshold thresholdPeriod
      channels { email { isEnabled endpoint minPeriod } slack { isEnabled endpoint minPeriod } loop { isEnabled endpoint minPeriod } telegram { isEnabled endpoint minPeriod } webhook { isEnabled endpoint minPeriod } }
    }
  }
}`,
  idempotent: true,
};

/** Creates a rule; repeating it would create a second rule, so no blind retries. */
export const CREATE_NOTIFICATION_RULE: GraphqlOperation = {
  name: 'CreateNotificationRule',
  document: 'mutation CreateNotificationRule($input: CreateProjectNotificationsRuleInput!) { createProjectNotificationsRule(input: $input) { id } }',
  idempotent: false,
};

/** Replaces a rule as a whole; the same input gives the same rule. */
export const UPDATE_NOTIFICATION_RULE: GraphqlOperation = {
  name: 'UpdateNotificationRule',
  document: 'mutation UpdateNotificationRule($input: UpdateProjectNotificationsRuleInput!) { updateProjectNotificationsRule(input: $input) { id } }',
  idempotent: true,
};

/** Deletes a rule; deleting twice leaves the same state. */
export const DELETE_NOTIFICATION_RULE: GraphqlOperation = {
  name: 'DeleteNotificationRule',
  document: 'mutation DeleteNotificationRule($input: ProjectNotificationRulePointer!) { deleteProjectNotificationsRule(input: $input) { id } }',
  idempotent: true,
};

/** Every operation the monitor sends. */
export const ALL_OPERATIONS: readonly GraphqlOperation[] = [LOGIN, REFRESH_TOKENS, PROJECT_TOKEN, WORKSPACE_QUOTA, FIND_EVENTS, EVENT_CARD, REMOVE_EVENT, NOTIFICATION_RULES, CREATE_NOTIFICATION_RULE, UPDATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE];
