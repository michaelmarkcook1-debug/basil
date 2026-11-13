/**
 * Revoke a deleted account's third-party grants at the provider.
 *
 * Deleting a Basil account purged the stored tokens but left the grants alive
 * at Google and Slack: the refresh token kept working for anyone holding a copy
 * (a backup, a warm instance's cache), and the user's Google "apps with access"
 * page still listed Basil (2026-11-10 bug pass, A10). Call this BEFORE
 * purgeUserData — the purge deletes the tokens this needs.
 *
 * Reads only the user's OWN stored tokens (getIntegrationToken), never the
 * env-var fallbacks in getStoredTokens / getSlackConfig: those are the
 * deployment owner's credentials, and revoking them would disconnect the owner.
 *
 * Only the Slack USER token is revoked. The bot token belongs to the workspace
 * install, which other Basil users in the same workspace may share.
 *
 * Best-effort: every failure is logged and swallowed, each call is bounded by a
 * timeout, and the result says what happened so the caller can log it.
 */
import "server-only";
import { getIntegrationToken } from "@/lib/storage/secure-token-store";

const REVOKE_TIMEOUT_MS = 5_000;

export type RevokeOutcome = "revoked" | "none" | "failed";
export interface RevokeResult { google: RevokeOutcome; slack: RevokeOutcome }

async function revokeGoogle(username: string): Promise<RevokeOutcome> {
  const tokens = await getIntegrationToken<{ refresh_token?: string; access_token?: string }>(username, "google");
  // Revoking the refresh token revokes the whole grant; the access token is the
  // fallback for a record that somehow has no refresh token.
  const token = tokens?.refresh_token || tokens?.access_token;
  if (!token) return "none";
  const res = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
  // 400 invalid_token: already revoked or expired — nothing left to revoke.
  if (res.ok || res.status === 400) return "revoked";
  console.warn(`[revoke-integrations] Google revoke for ${username} returned ${res.status}`);
  return "failed";
}

async function revokeSlack(username: string): Promise<RevokeOutcome> {
  const config = await getIntegrationToken<{ userToken?: string }>(username, "slack");
  const token = config?.userToken;
  if (!token) return "none";
  const res = await fetch("https://slack.com/api/auth.revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { ok?: boolean; revoked?: boolean; error?: string } | null; // ci-ok: an unreadable body falls through to "failed" below and is logged
  // invalid_auth / token_revoked: the token is already dead.
  if (body?.ok || body?.error === "invalid_auth" || body?.error === "token_revoked") return "revoked";
  console.warn(`[revoke-integrations] Slack auth.revoke for ${username} failed: ${body?.error ?? res.status}`);
  return "failed";
}

const settle = (p: Promise<RevokeOutcome>, label: string, username: string): Promise<RevokeOutcome> =>
  p.catch((err) => {
    console.warn(`[revoke-integrations] ${label} revoke for ${username} threw:`, err instanceof Error ? err.message : err);
    return "failed" as const;
  });

/** Revoke the user's Google grant and Slack user token. Never throws. */
export async function revokeIntegrationTokens(username: string): Promise<RevokeResult> {
  const [google, slack] = await Promise.all([
    settle(revokeGoogle(username), "Google", username),
    settle(revokeSlack(username), "Slack", username),
  ]);
  return { google, slack };
}
