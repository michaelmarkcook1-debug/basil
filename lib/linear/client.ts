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
 * Never throws — returns empty array on failure.
 */
export async function getMyOpenIssues(username: string): Promise<LinearIssue[]> {
  try {
    const config = await getLinearConfig(username);
    if (!config.apiKey) return [];
    const data = await gql<OpenIssuesResult>(config.apiKey, OPEN_ISSUES_QUERY);
    return data.issues.nodes;
  } catch (err) {
    console.error("[linear] getMyOpenIssues error:", err);
    return [];
  }
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

/**
 * Map Linear priority number → Basil priority string.
 */
export function linearPriorityToBasil(p: number): "high" | "medium" | "low" {
  if (p === 1 || p === 2) return "high";
  if (p === 3) return "medium";
  return "low";
}
