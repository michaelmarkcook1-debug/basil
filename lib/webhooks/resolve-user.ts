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
import { getSlackConfig, getSlackUserClientForUser } from "@/lib/slack/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getSelfIdentity } from "@/lib/self-identity";

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
  enterpriseId?: string | null,
  /**
   * Slack user ids the event was delivered for (event_callback
   * `authorizations[].user_id` where !is_bot, plus legacy `authed_users`).
   * Two Basil users in one workspace share a team_id; this is what tells
   * their events apart.
   */
  authorizedSlackUsers: readonly string[] = [],
): Promise<string | "ambiguous" | null> {
  if (!teamId) return null;

  const users = await getUsers();
  const matches: { username: string; authUserId?: string; legacy: boolean }[] = [];

  for (const user of users) {
    try {
      const config = await getSlackConfig(user.username);
      if (!config.teamId) {
        // Connected by env tokens or before workspace metadata was stored: the
        // workspace is unknown, so it is a candidate. Counting it means a
        // colleague who connects the same workspace makes routing ambiguous
        // rather than inheriting every event (2026-11-02).
        if (config.botToken || config.userToken) matches.push({ username: user.username, legacy: true });
        continue;
      }

      const teamMatches = config.teamId === teamId;
      const enterpriseMatches =
        !enterpriseId ||
        !config.enterpriseId ||
        config.enterpriseId === enterpriseId;

      if (teamMatches && enterpriseMatches) {
        matches.push({ username: user.username, authUserId: config.authUserId, legacy: false });
      }
    } catch {
      // Skip users whose Slack config can't be read
    }
  }

  if (matches.length === 0) return null;

  // Prefer the user the event was authorised for: they can see it by definition.
  const authed = new Set(authorizedSlackUsers.filter(Boolean));
  if (authed.size > 0 && matches.length > 1) {
    for (const m of matches) if (m.legacy && !m.authUserId) m.authUserId = await slackSelfId(m.username);
    const mine = matches.filter((m) => m.authUserId && authed.has(m.authUserId));
    if (mine.length === 1) return mine[0].username;
  }

  if (matches.length === 1) return matches[0].username;
  return "ambiguous";
}

/** Slack user id behind a user's own token (auth.test), for configs that never stored it. */
const slackSelfIdCache = new Map<string, string | undefined>();
async function slackSelfId(username: string): Promise<string | undefined> {
  if (slackSelfIdCache.has(username)) return slackSelfIdCache.get(username);
  let id: string | undefined;
  try {
    const web = await getSlackUserClientForUser(username);
    id = web ? ((await web.auth.test()).user_id as string | undefined) : undefined;
  } catch (e) {
    console.warn(`[slack-webhook] auth.test failed for ${username}:`, e instanceof Error ? e.message : e);
  }
  slackSelfIdCache.set(username, id);
  return id;
}

/**
 * Find the Basil user who owns a Zoom webhook event.
 * Matches host_email to a connected user. The old "first connected user"
 * fallback is a cross-tenant data-injection bug: with 2+ Zoom users it would
 * attribute anyone's meeting to whoever happened to connect first. So we only
 * fall back when there is EXACTLY ONE Zoom-connected user (unambiguous — the
 * single-user case); with multiple, an unmatched host resolves to null (no-op).
 */
export async function resolveZoomUser(hostEmail?: string): Promise<string | null> {
  const users = await getUsers();

  const zoomUsers: string[] = [];
  for (const user of users) {
    if (await isZoomConnected(user.username)) zoomUsers.push(user.username);
  }

  // Match the meeting host to a Basil user by any of their own addresses
  // (login email plus the mailboxes they connected), not just the login email.
  if (hostEmail) {
    const host = hostEmail.toLowerCase();
    for (const u of users) {
      const own = new Set([u.username.toLowerCase(), (u.email ?? "").toLowerCase()]);
      for (const e of (await getSelfIdentity(u.username)).emails) own.add(e.toLowerCase());
      // The host is a Basil user: theirs or nobody's. Before 2026-11-02 a
      // colleague's meeting fell through to the single Zoom-connected user.
      if (own.has(host)) return zoomUsers.includes(u.username) ? u.username : null;
    }
  }

  // A host address no Basil user owns (e.g. a Zoom login on another address)
  // is attributed only when exactly one account has Zoom connected.
  return zoomUsers.length === 1 ? zoomUsers[0] : null;
}
