/**
 * Webhook user resolution — maps inbound notification identifiers to the
 * owning username by scanning each user's watch state files.
 *
 * All resolvers return null (not a guessed username) when no match is found.
 * Callers must route unresolvable payloads to the dead-letter store rather
 * than writing to an arbitrary user's data.
 */

import { getUsers } from "@/lib/users";
import { getWatchState as getGoogleWatchState } from "@/lib/google/watch-state";
import { getWatchState as getMicrosoftWatchState } from "@/lib/microsoft/watch-state";
import { getSlackConfig } from "@/lib/slack/client";

/**
 * Resolve which user owns a Gmail watch by matching the notification's
 * emailAddress to the watchedEmail stored at registration time.
 */
export async function resolveGmailUser(emailAddress: string): Promise<string | null> {
  if (!emailAddress) return null;
  const users = await getUsers();
  for (const user of users) {
    try {
      const state = await getGoogleWatchState(user.username);
      if (
        state.gmail?.watchedEmail &&
        state.gmail.watchedEmail.toLowerCase() === emailAddress.toLowerCase()
      ) {
        return user.username;
      }
    } catch {
      // Skip users whose watch state can't be read
    }
  }
  return null;
}

/**
 * Resolve which user owns a Google Calendar watch channel by matching the
 * X-Goog-Channel-Id header value to the stored channelId.
 */
export async function resolveCalendarChannelUser(channelId: string): Promise<string | null> {
  if (!channelId) return null;
  const users = await getUsers();
  for (const user of users) {
    try {
      const state = await getGoogleWatchState(user.username);
      if (state.calendar?.channelId === channelId) {
        return user.username;
      }
    } catch {
      // Skip users whose watch state can't be read
    }
  }
  return null;
}

/**
 * Resolve which user owns a Microsoft Graph subscription by matching the
 * subscriptionId in the notification to the stored subscription IDs.
 */
export async function resolveMicrosoftSubscriptionUser(
  subscriptionId: string,
  resource: "mail" | "calendar"
): Promise<string | null> {
  if (!subscriptionId) return null;
  const users = await getUsers();
  for (const user of users) {
    try {
      const state = await getMicrosoftWatchState(user.username);
      const sub = resource === "mail" ? state.mail : state.calendar;
      if (sub?.subscriptionId === subscriptionId) {
        return user.username;
      }
    } catch {
      // Skip users whose watch state can't be read
    }
  }
  return null;
}

/**
 * Resolve the first user who has Slack configured (has a bot or user token).
 *
 * @deprecated Use resolveSlackUserByTeam() instead. This resolver uses first-match
 * semantics and is only correct in single-user deployments. It is kept for backward
 * compatibility with callers that do not yet have a team_id.
 */
export async function resolveSlackUser(): Promise<string | null> {
  const users = await getUsers();
  for (const user of users) {
    try {
      const config = await getSlackConfig(user.username);
      if (config.botToken || config.userToken) {
        return user.username;
      }
    } catch {
      // Skip users without Slack config
    }
  }
  return null;
}

/**
 * Resolve the user who owns a Slack workspace by matching the workspace's
 * team_id (and optionally enterprise_id for Enterprise Grid) to the metadata
 * stored at OAuth connect time.
 *
 * Returns:
 *   - a username string   — exactly one match
 *   - "ambiguous"         — multiple users share the same workspace (unusual but possible)
 *   - null                — no user has this workspace connected
 *
 * Callers must dead-letter events that return "ambiguous" or null.
 */
export async function resolveSlackUserByTeam(
  teamId: string,
  enterpriseId?: string | null
): Promise<string | "ambiguous" | null> {
  if (!teamId) return null;

  const users = await getUsers();
  const matches: string[] = [];

  for (const user of users) {
    try {
      const config = await getSlackConfig(user.username);
      if (!config.teamId) continue;

      const teamMatches = config.teamId === teamId;
      const enterpriseMatches =
        !enterpriseId ||
        !config.enterpriseId ||
        config.enterpriseId === enterpriseId;

      if (teamMatches && enterpriseMatches) {
        matches.push(user.username);
      }
    } catch {
      // Skip users whose Slack config can't be read
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return "ambiguous";
}
