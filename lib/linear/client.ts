/**
 * Linear API client — Personal API Key auth.
 *
 * Uses Linear's GraphQL API. Credentials are stored per-user in the
 * persistent store (same pattern as Slack tokens).
 */

import { getIntegrationToken, saveIntegrationToken, deleteIntegrationToken } from "@/lib/storage/secure-token-store";

const LINEAR_API = "https://api.linear.app/graphql";

// ── Config storage ─────────────────────────────────────────────────────────

interface LinearConfig {
  apiKey?: string;
}

export async function getLinearConfig(username: string): Promise<LinearConfig> {
  return (await getIntegrationToken<LinearConfig>(username, "linear")) ?? {};
}

export async function saveLinearConfig(username: string, config: LinearConfig): Promise<void> {
  await saveIntegrationToken(username, "linear", config);
}

export async function deleteLinearConfig(username: string): Promise<void> {
  await deleteIntegrationToken(username, "linear");
}

export async function isLinearConnected(username: string): Promise<boolean> {
  const config = await getLinearConfig(username);
  return !!config.apiKey;
}

// ── GraphQL helper ─────────────────────────────────────────────────────────

async function gql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Linear API HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return json.data as T;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface LinearIssue {
  id: string;
  identifier: string;   // e.g. "ANA-22"
  title: string;
  description?: string;
  priority: number;     // 0=None, 1=Urgent, 2=High, 3=Normal, 4=Low
  state: { name: string; type: string };
  team: { name: string };
  project?: { name: string } | null;
  dueDate?: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
  assignee?: { id: string; name: string } | null;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  color: string;
  team: { id: string };
}

export interface LinearIssueInput {
  title: string;
  description?: string;
  teamId: string;
  stateId?: string;
  priority?: number;
  dueDate?: string | null;
}

// ── Queries ────────────────────────────────────────────────────────────────

const OPEN_ISSUES_QUERY = `
  query OpenIssues {
    issues(
      filter: {
        assignee: { isMe: { eq: true } }
        state: { type: { nin: ["completed", "cancelled"] } }
      }
      orderBy: updatedAt
      first: 50
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        state { name type }
        team { name }
        project { name }
        dueDate
        url
        createdAt
        updatedAt
      }
    }
  }
`;

interface OpenIssuesResult {
  issues: { nodes: LinearIssue[] };
}

/**
 * Returns all open Linear issues assigned to the authenticated user.
 * Throws on API/network failure so the caller can distinguish error from empty.
 */
export async function getMyOpenIssues(username: string): Promise<LinearIssue[]> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) return [];
  const data = await gql<OpenIssuesResult>(config.apiKey, OPEN_ISSUES_QUERY);
  return data.issues.nodes;
}

// ── Teams ──────────────────────────────────────────────────────────────────

const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        name
        key
      }
    }
  }
`;

interface TeamsResult {
  teams: { nodes: LinearTeam[] };
}

export async function getTeams(username: string): Promise<LinearTeam[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const data = await gql<TeamsResult>(config.apiKey, TEAMS_QUERY);
    return data.teams.nodes;
  } catch (err) {
    console.error("[linear] getTeams error:", err);
    return [];
  }
}

// ── Workflow States ────────────────────────────────────────────────────────

const WORKFLOW_STATES_ALL_QUERY = `
  query WorkflowStates {
    workflowStates(orderBy: updatedAt) {
      nodes {
        id name type color
        team { id }
      }
    }
  }
`;

const WORKFLOW_STATES_FILTERED_QUERY = `
  query WorkflowStatesByTeam($teamId: ID!) {
    workflowStates(filter: { team: { id: { eq: $teamId } } }, orderBy: updatedAt) {
      nodes {
        id name type color
        team { id }
      }
    }
  }
`;

interface WorkflowStatesResult {
  workflowStates: { nodes: LinearWorkflowState[] };
}

export async function getWorkflowStates(username: string, teamId?: string): Promise<LinearWorkflowState[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const data = teamId
      ? await gql<WorkflowStatesResult>(config.apiKey, WORKFLOW_STATES_FILTERED_QUERY, { teamId })
      : await gql<WorkflowStatesResult>(config.apiKey, WORKFLOW_STATES_ALL_QUERY);
    return data.workflowStates.nodes;
  } catch (err) {
    console.error("[linear] getWorkflowStates error:", err);
    return [];
  }
}

// ── All Issues (with optional filters) ────────────────────────────────────

const ISSUE_FRAGMENT = `
  id identifier title description priority dueDate url createdAt updatedAt
  state { name type }
  team { name }
  project { name }
  assignee { id name }
`;

interface AllIssuesResult {
  issues: { nodes: LinearIssue[] };
}

export interface IssueFilters {
  teamId?: string;
  stateType?: string;
  assigneeIsMe?: boolean;
}

export async function getAllIssues(username: string, filters?: IssueFilters): Promise<LinearIssue[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];

    const filterParts: string[] = [];
    if (filters?.teamId) filterParts.push(`team: { id: { eq: "${filters.teamId}" } }`);
    if (filters?.stateType) filterParts.push(`state: { type: { eq: "${filters.stateType}" } }`);
    if (filters?.assigneeIsMe) filterParts.push(`assignee: { isMe: { eq: true } }`);

    const filterBlock = filterParts.length > 0 ? `filter: { ${filterParts.join(" ")} }` : "";

    const query = `
      query AllIssues {
        issues(
          ${filterBlock}
          orderBy: updatedAt
          first: 100
        ) {
          nodes {
            ${ISSUE_FRAGMENT}
          }
        }
      }
    `;

    const data = await gql<AllIssuesResult>(config.apiKey, query);
    return data.issues.nodes;
  } catch (err) {
    console.error("[linear] getAllIssues error:", err);
    return [];
  }
}

// ── Create Issue ───────────────────────────────────────────────────────────

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        ${ISSUE_FRAGMENT}
      }
    }
  }
`;

interface IssueCreateResult {
  issueCreate: { success: boolean; issue: LinearIssue };
}

export async function createIssue(username: string, input: LinearIssueInput): Promise<LinearIssue> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  const data = await gql<IssueCreateResult>(config.apiKey, CREATE_ISSUE_MUTATION, { input });
  if (!data.issueCreate.success) throw new Error("Issue creation failed");
  return data.issueCreate.issue;
}

// ── Update Issue ───────────────────────────────────────────────────────────

const UPDATE_ISSUE_MUTATION = `
  mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
        ${ISSUE_FRAGMENT}
      }
    }
  }
`;

interface IssueUpdateResult {
  issueUpdate: { success: boolean; issue: LinearIssue };
}

export async function updateIssue(
  username: string,
  id: string,
  input: Partial<LinearIssueInput> & { stateId?: string }
): Promise<LinearIssue> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  const data = await gql<IssueUpdateResult>(config.apiKey, UPDATE_ISSUE_MUTATION, { id, input });
  if (!data.issueUpdate.success) throw new Error("Issue update failed");
  return data.issueUpdate.issue;
}

// ── Contact activity query ─────────────────────────────────────────────────

export interface LinearContactActivity {
  /** The contact's display name as seen in Linear (assignee or creator). */
  personName: string;
  /** The contact's email if Linear has it (may be undefined). */
  personEmail?: string;
  /** ISO date string when the issue was last updated. */
  updatedAt: string;
  /** Human-readable description for the interaction log. */
  description: string;
}

const RECENT_TEAM_ISSUES_QUERY = `
  query RecentTeamIssues($updatedAfter: DateTime!) {
    issues(
      filter: { updatedAt: { gte: $updatedAfter } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        updatedAt
        assignee { name email }
        creator  { name email }
      }
    }
  }
`;

interface TeamIssueNode {
  identifier: string;
  title: string;
  updatedAt: string;
  assignee?: { name: string; email?: string } | null;
  creator?:  { name: string; email?: string } | null;
}

interface RecentTeamIssuesResult {
  issues: { nodes: TeamIssueNode[] };
}

/**
 * Returns recent Linear activity (issues updated in the last `days` days)
 * annotated with the assignee and creator name/email — suitable for
 * cross-referencing against the contacts list to determine last interaction.
 * Never throws — returns empty array on failure.
 */
export async function getRecentLinearActivity(
  username: string,
  days = 30
): Promise<LinearContactActivity[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const updatedAfter = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const data = await gql<RecentTeamIssuesResult>(
      config.apiKey,
      RECENT_TEAM_ISSUES_QUERY,
      { updatedAfter }
    );
    const entries: LinearContactActivity[] = [];
    for (const issue of data.issues.nodes) {
      const desc = `Linear: ${issue.identifier} — ${issue.title}`;
      if (issue.assignee?.name) {
        entries.push({
          personName: issue.assignee.name,
          personEmail: issue.assignee.email || undefined,
          updatedAt: issue.updatedAt,
          description: desc,
        });
      }
      if (issue.creator?.name && issue.creator.name !== issue.assignee?.name) {
        entries.push({
          personName: issue.creator.name,
          personEmail: issue.creator.email || undefined,
          updatedAt: issue.updatedAt,
          description: desc,
        });
      }
    }
    return entries;
  } catch (err) {
    console.error("[linear] getRecentLinearActivity error:", err);
    return [];
  }
}

/**
 * Validate an API key by fetching viewer info. Returns the viewer's name on
 * success, throws on failure.
 */
export async function validateApiKey(apiKey: string): Promise<string> {
  const data = await gql<{ viewer: { name: string } }>(
    apiKey,
    `query { viewer { name } }`
  );
  return data.viewer.name;
}

// ── Comments ───────────────────────────────────────────────────────────────

export interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string };
}

const ISSUE_COMMENTS_QUERY = `
  query IssueComments($id: String!) {
    issue(id: $id) {
      comments(orderBy: createdAt) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user { id name }
        }
      }
    }
  }
`;

interface IssueCommentsResult {
  issue: { comments: { nodes: LinearComment[] } };
}

export async function getIssueComments(
  username: string,
  issueId: string
): Promise<LinearComment[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const data = await gql<IssueCommentsResult>(config.apiKey, ISSUE_COMMENTS_QUERY, { id: issueId });
    return data.issue.comments.nodes;
  } catch (err) {
    console.error("[linear] getIssueComments error:", err);
    return [];
  }
}

const CREATE_COMMENT_MUTATION = `
  mutation CreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
        body
        createdAt
        updatedAt
        user { id name }
      }
    }
  }
`;

interface CommentCreateResult {
  commentCreate: { success: boolean; comment: LinearComment };
}

export async function createComment(
  username: string,
  issueId: string,
  body: string
): Promise<LinearComment> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  const data = await gql<CommentCreateResult>(config.apiKey, CREATE_COMMENT_MUTATION, {
    issueId,
    body,
  });
  if (!data.commentCreate.success) throw new Error("Comment creation failed");
  return data.commentCreate.comment;
}

// ── Inbox / Notifications ──────────────────────────────────────────────────

export interface LinearNotification {
  id: string;
  type: string;
  readAt: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
  // IssueNotification fields
  issue?: {
    id: string;
    identifier: string;
    title: string;
    url: string;
    priority: number;
    state: { name: string; type: string };
  };
  comment?: {
    id: string;
    body: string;
    createdAt: string;
  } | null;
}

const NOTIFICATIONS_QUERY = `
  query MyNotifications($first: Int) {
    notifications(first: $first, orderBy: createdAt) {
      nodes {
        id
        type
        readAt
        createdAt
        actor { id name }
        ... on IssueNotification {
          issue {
            id
            identifier
            title
            url
            priority
            state { name type }
          }
          comment { id body createdAt }
        }
      }
    }
  }
`;

interface NotificationsResult {
  notifications: { nodes: LinearNotification[] };
}

export async function getNotifications(
  username: string,
  limit = 50
): Promise<LinearNotification[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const data = await gql<NotificationsResult>(config.apiKey, NOTIFICATIONS_QUERY, {
      first: limit,
    });
    return data.notifications.nodes;
  } catch (err) {
    console.error("[linear] getNotifications error:", err);
    return [];
  }
}

const NOTIFICATION_ARCHIVE_MUTATION = `
  mutation NotificationArchive($id: String!) {
    notificationArchive(id: $id) {
      success
    }
  }
`;

const NOTIFICATION_MARK_READ_MUTATION = `
  mutation NotificationUpdate($id: String!, $readAt: DateTime!) {
    notificationUpdate(id: $id, input: { readAt: $readAt }) {
      success
      notification { id readAt }
    }
  }
`;

const NOTIFICATIONS_MARK_ALL_READ_MUTATION = `
  mutation NotificationsMarkAllRead {
    notificationMarkAllAsRead {
      success
    }
  }
`;

export async function archiveNotification(username: string, id: string): Promise<void> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  await gql(config.apiKey, NOTIFICATION_ARCHIVE_MUTATION, { id });
}

export async function markNotificationRead(username: string, id: string): Promise<void> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  await gql(config.apiKey, NOTIFICATION_MARK_READ_MUTATION, {
    id,
    readAt: new Date().toISOString(),
  });
}

export async function markAllNotificationsRead(username: string): Promise<void> {
  const config = await getLinearConfig(username);
  if (!config.apiKey) throw new Error("Linear not connected");
  await gql(config.apiKey, NOTIFICATIONS_MARK_ALL_READ_MUTATION);
}

// ── Map Linear priority number → Basil priority string ────────────────────

/**
 * Map Linear priority number → Basil priority string.
 */
export function linearPriorityToBasil(p: number): "high" | "medium" | "low" {
  if (p === 1 || p === 2) return "high";
  if (p === 3) return "medium";
  return "low";
}
