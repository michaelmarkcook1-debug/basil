import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { isLinearConnected } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getSnapshotDiagnostics } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";
import { getWatchState } from "@/lib/google/watch-state";
import { autoRegisterGoogleWebhooks } from "@/lib/google/register-webhooks";
import type { IntegrationStatus } from "@/lib/integrations/types";

// How long before expiry to consider a watch "stale" (trigger early renewal)
const STALE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * GET /api/integrations/status
 *
 * Returns the concrete connection state for every integration, scoped to the
 * logged-in user.  Each check reads from the persistent store — no external
 * API calls are made — so it resolves quickly and never hangs.
 *
 * When Google is connected but Gmail/Calendar watch state is missing or
 * expiring within 3 days, registration is auto-triggered in the background
 * (fire-and-forget).  This self-heals existing connections that pre-date the
 * auto-registration logic in the OAuth callback.
 */
export async function GET() {
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    // ── Google ─────────────────────────────────────────────────────────────
    let google: Awaited<ReturnType<typeof getGoogleConnectionStatus>>;
    try {
      google = await getGoogleConnectionStatus(username);
    } catch (err) {
      console.error("[integrations/status] Google status check failed:", err);
      google = { id: "google", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Google webhook watch health ─────────────────────────────────────────
    // If Google is connected, check whether Gmail push and Calendar watch are
    // active.  If either is missing or expiring soon, auto-register in the
    // background — no user action required.
    let watchHealth: { gmail: string; calendar: string } | undefined;
    if (google.state === "connected") {
      try {
        const watchState = await getWatchState(username);
        const gmailOk = !!watchState.gmail?.expiration && watchState.gmail.expiration - nowMs > STALE_MS;
        const calOk   = !!watchState.calendar?.channelId && !!watchState.calendar?.expiration && watchState.calendar.expiration - nowMs > STALE_MS;

        watchHealth = {
          gmail:    gmailOk ? "active" : "registering",
          calendar: calOk   ? "active" : "registering",
        };

        if (!gmailOk || !calOk) {
          // Fire-and-forget: heal in background, do not block this response
          autoRegisterGoogleWebhooks(username).then(({ gmail, calendar }) => {
            console.log(`[integrations/status] Auto-register: gmail=${gmail} calendar=${calendar} user=${username}`);
          }).catch((err) => {
            console.error("[integrations/status] Auto-register error:", err instanceof Error ? err.message : err);
          });
        }
      } catch (watchErr) {
        console.error("[integrations/status] Watch state check failed:", watchErr);
      }
    }

    // ── Slack ───────────────────────────────────────────────────────────────
    const slackConnected = await isSlackConnected(username);
    const slack: IntegrationStatus = {
      id:            "slack",
      state:         slackConnected ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Microsoft 365 ───────────────────────────────────────────────────────
    let microsoft: Awaited<ReturnType<typeof getMicrosoftConnectionStatus>>;
    try {
      microsoft = await getMicrosoftConnectionStatus(username);
    } catch (err) {
      console.error("[integrations/status] Microsoft status check failed:", err);
      microsoft = { id: "microsoft", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Linear ──────────────────────────────────────────────────────────────
    const linearConnected = await isLinearConnected(username);
    const linear: IntegrationStatus = {
      id:            "linear",
      state:         linearConnected ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Claude / Anthropic ──────────────────────────────────────────────────
    const claude: IntegrationStatus = {
      id:            "claude",
      state:         process.env.ANTHROPIC_API_KEY ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Zoom ────────────────────────────────────────────────────────────────
    const zoomConnected = await isZoomConnected(username);
    const zoom: IntegrationStatus = {
      id:            "zoom",
      state:         zoomConnected ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Snapshot diagnostics ────────────────────────────────────────────────
    const snapshot = getSnapshotDiagnostics();

    return NextResponse.json({ google, slack, microsoft, linear, claude, zoom, snapshot, watchHealth });
  } catch (err) {
    console.error("[integrations/status] Unexpected error:", err);
    return NextResponse.json(
      { error: "Status check failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
