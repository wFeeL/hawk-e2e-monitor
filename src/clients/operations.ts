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

/** Integration token of a project and the patterns that group its events. */
export const PROJECT_TOKEN: GraphqlOperation = {
  name: 'ProjectToken',
  document: 'query ProjectToken($projectId: ID!) { project(projectId: $projectId) { token eventGroupingPatterns { pattern } } }',
  idempotent: true,
};

/** Workspace of a project with its plan limit and event counter. */
export const WORKSPACE_QUOTA: GraphqlOperation = {
  name: 'WorkspaceQuota',
  document: 'query WorkspaceQuota($projectId: ID!) { workspaces { id isBlocked billingPeriodEventsCount plan { eventsLimit } projects(ids: [$projectId]) { id } } }',
  idempotent: true,
};

// The three fragments and the two queries below are the ones of the Garage web client (hawk.garage, src/api/fragments.ts and src/api/events/queries.ts), word for word.
const USER_FRAGMENT = `
  fragment User on User {
    id
    email
    name
    image
  }
`;

const EVENT_BACKTRACE = `
  fragment eventBacktrace on EventBacktraceFrame {
    file
    line
    column
    sourceCode {
      line
      content
    }
    function
    arguments
  }
`;

const EVENT_FRAGMENT = `
  fragment Event on Event {
    id
    catcherType
    totalCount
    assignee {
      id
      name
      email
      image
    }
    groupHash
    visitedBy {
      ...User
    }
    marks {
      resolved
      starred
      ignored
    }
    timestamp
    originalTimestamp
    originalEventId
    firstSeenInRelease
    isNew
    resolvedInRelease
    regressionInRelease
    payload {
      title
      type
      release
      context
      user {
        id
        name
        url
        photo
      }
      get
      backtrace {
        ...eventBacktrace
      }
      addons
      breadcrumbs {
        timestamp
        type
        category
        message
        level
        data
      }
    }
    usersAffected
    release {
      releaseName
      commits{
        hash
        author
        title
        date
      }
    }
    taskManagerItem {
      type
      number
      url
      title
      createdBy
      createdAt
      assignee
    }
  }

  ${USER_FRAGMENT}
  ${EVENT_BACKTRACE}
`;

/** Events of a project found by a search string, as the event list of Garage asks for them. */
export const PROJECT_DAILY_EVENTS: GraphqlOperation = {
  name: 'ProjectDailyEvents',
  document: `
  query ProjectDailyEvents(
    $projectId: ID!
    $cursor: DailyEventsCursorInput
    $sort: EventsSortOrder
    $filters: EventsFiltersInput
    $search: String
    $release: String
    $assignee: ID
  ) {
    project(projectId: $projectId) {
      dailyEventsPortion(sort: $sort, filters: $filters, search: $search, release: $release, assignee: $assignee, nextCursor: $cursor) {
        nextCursor {
          groupingTimestampBoundary
          sortValueBoundary
          idBoundary
        }
        dailyEvents {
          id
          count
          affectedUsers
          groupingTimestamp
          event {
            ...Event
          }
        }
      }
    }
  }

  ${EVENT_FRAGMENT}
`,
  idempotent: true,
  garage: true,
};

/** Card of one event as the event page of Garage asks for it. */
export const EVENT: GraphqlOperation = {
  name: 'Event',
  document: `
  query Event($projectId: ID!, $eventId: ID!, $originalEventId: ID!) {
    project(projectId: $projectId) {
      event(eventId: $eventId, originalEventId: $originalEventId) {
        ...Event
      }
    }
  }

  ${EVENT_FRAGMENT}
`,
  idempotent: true,
  garage: true,
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

/** Creates a project in a workspace; repeating it would create a second project, so no blind retries. */
export const CREATE_PROJECT: GraphqlOperation = {
  name: 'CreateProject',
  document: 'mutation CreateProject($workspaceId: ID!, $name: String!) { createProject(workspaceId: $workspaceId, name: $name) { id name token } }',
  idempotent: false,
};

/** Removes a project; once it is gone a second request fails, so no blind retries. */
export const REMOVE_PROJECT: GraphqlOperation = {
  name: 'RemoveProject',
  document: 'mutation RemoveProject($projectId: ID!) { removeProject(projectId: $projectId) }',
  idempotent: false,
};

/** Projects of each workspace of the account, all of them or only the listed ones. */
export const WORKSPACE_PROJECTS: GraphqlOperation = {
  name: 'WorkspaceProjects',
  document: 'query WorkspaceProjects($ids: [ID!]) { workspaces { id projects(ids: $ids) { id name creationDate } } }',
  idempotent: true,
};

/** Every operation the monitor sends. */
export const ALL_OPERATIONS: readonly GraphqlOperation[] = [LOGIN, REFRESH_TOKENS, PROJECT_TOKEN, WORKSPACE_QUOTA, PROJECT_DAILY_EVENTS, EVENT, REMOVE_EVENT, NOTIFICATION_RULES, CREATE_NOTIFICATION_RULE, UPDATE_NOTIFICATION_RULE, DELETE_NOTIFICATION_RULE, CREATE_PROJECT, REMOVE_PROJECT, WORKSPACE_PROJECTS];
