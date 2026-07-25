import { NextResponse } from "next/server";
import {
  getRecentSlackMessages,
  getSlackBotClientForUser,
  getSlackUserClientForUser,
} from "@/lib/slack/client";
import { getUsers } from "@/lib/users";
import { getSlackConfig } from "@/lib/slack/client";
import { writeUserStore, readUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";

// Loops every connected user sequentially — give it the platform-max budget so
// the tail of the user list isn't silently truncated as accounts grow.
export const maxDuration = 300;

// Vercel cron hits this hourly — warms the in-memory Slack cache for every
// connected user AND probes `auth.test` so revoked tokens surface within ~1h
// instead of going silent until the user notices messages aren't sending.

/**
 * Slack error codes that mean the token is permanently dead and needs the
 * user to re-OAuth. Any other error (rate-limit, network) is transient and
 * NOT treated as a disconnect.
 */
const FATAL_AUTH_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "token_expired",
  "not_authed",
]);

function isFatalAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return [...FATAL_AUTH_ERRORS].some((code) => msg.includes(code));
}
export async function GET(req: Request) {
  // Require CRON_SECRET — fail closed: if the secret is not set, deny all
  // callers so the endpoint is never accidentally open. (Matches the other six
  // cron routes.) Previously this was the lone outlier: it omitted the
  // !cronSecret guard, so an unset/rotated-out secret made the comparison
  // `authHeader !== "Bearer undefined"` — any caller sending that exact header
  // got in. It was also fully open outside NODE_ENV==="production", and it fans
  // out over EVERY user's Slack, so an open door here is a DoS + rate-limit burn.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const users = await getUsers();
  const results: Record<string, unknown> = {};
  let totalMessages = 0;

  for (const user of users) {
    const username = user.username;
    try {
      const config = await getSlackConfig(username);
      if (!config.botToken && !config.userToken) {
        // User doesn't have Slack connected — skip silently
        continue;
      }

      // ── Token health probe ─────────────────────────────────────────────────
      // Call auth.test on whichever client we have. A revoked / inactive token
      // throws here; we capture and surface via slackTokenInvalid so the UI
      // can show "Reconnect Slack" instead of a vague "stale data" warning.
      const probeClient =
        (await getBotOrUserClient(username, config.botToken, config.userToken));
      let tokenInvalid = false;
      let probeError: string | undefined;
      try {
        if (probeClient) await probeClient.auth.test();
      } catch (authErr) {
        if (isFatalAuthError(authErr)) {
          tokenInvalid = true;
          probeError = authErr instanceof Error ? authErr.message : String(authErr);
          console.warn(
            `[slack-sync] token for ${username} is invalid (${probeError}) — flagging for reconnect`
          );
        }
        // Non-fatal errors (rate limit, network) — leave tokenInvalid false
      }

      // If token is dead, skip the message fetch (it would just fail) and
      // record the state. If it's healthy, proceed with the cache warm.
      let cachedCount = 0;
      if (!tokenInvalid) {
        try {
          const messages = await getRecentSlackMessages(username, 200, 30);
          cachedCount = messages.length;
          totalMessages += cachedCount;
          console.log(`[slack-sync] ${username}: cached ${cachedCount} messages`);
        } catch (fetchErr) {
          // If the fetch itself returns invalid_auth, flag now even if probe
          // happened to pass earlier (the token may have just been revoked).
          if (isFatalAuthError(fetchErr)) {
            tokenInvalid = true;
            probeError = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          } else {
            throw fetchErr;
          }
        }
      }

      results[username] = tokenInvalid
        ? { ok: false, tokenInvalid: true, error: probeError }
        : { ok: true, count: cachedCount };

      // Write health metadata so the UI can render the precise state.
      try {
        const existing = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
        const next: HealthMeta = {
          ...existing,
          slackTokenInvalid: tokenInvalid,
          slackTokenCheckedAt: new Date().toISOString(),
        };
        // Only bump lastSlackSyncAt on a healthy sync — leaving the old
        // value when invalid means the UI shows the real last good sync.
        if (!tokenInvalid) next.lastSlackSyncAt = new Date().toISOString();
        await writeUserStore<HealthMeta>(username, HEALTH_META_FILE, next);
      } catch (metaErr) {
        console.warn(`[slack-sync] Failed to write health-meta for ${username}:`, metaErr instanceof Error ? metaErr.message : metaErr);
      }
    } catch (e) {
      results[username] = { ok: false, error: String(e) };
      console.error(`[slack-sync] Error for ${username}:`, e);
    }
  }

  return NextResponse.json({
    ok: true,
    totalMessages,
    refreshed: new Date().toISOString(),
    users: results,
  });
}

/**
 * Returns whichever Slack WebClient is available for the user, prioritising
 * the bot client (broader scopes for probing). Returns null when neither
 * token is stored — caller should already have short-circuited in that case.
 */
async function getBotOrUserClient(
  username: string,
  botToken: string | undefined,
  userToken: string | undefined
): Promise<{ auth: { test: () => Promise<unknown> } } | null> {
  if (botToken) return await getSlackBotClientForUser(username);
  if (userToken) return await getSlackUserClientForUser(username);
  return null;
}
