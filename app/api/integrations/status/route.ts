import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { getSnapshotDiagnostics } from "@/lib/storage/persistent";
import type { IntegrationStatus } from "@/lib/integrations/types";

/**
 * GET /api/integrations/status
 *
 * Lightweight endpoint that returns the concrete connection state for every
 * integration.  Each check reads from the persistent store — no external
 * API calls are made — so it resolves quickly and never hangs.
 *
 * This is the canonical source of truth for the Settings page and any other
 * surface that needs integration health.  The old /api/google/status and the
 * heavyweight /api/slack endpoint should NOT be called for status checks.
 */
export async function GET() {
  const now = new Date().toISOString();

  try {
    // ── Google ─────────────────────────────────────────────────────────────
    let google: Awaited<ReturnType<typeof getGoogleConnectionStatus>>;
    try {
      google = await getGoogleConnectionStatus();
    } catch (err) {
      console.error("[integrations/status] Google status check failed:", err);
      google = { id: "google", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Slack ───────────────────────────────────────────────────────────────
    // Token presence is the only check we do here — no Slack API call.
    // The heavy /api/slack endpoint is only for fetching actual messages.
    const hasSlackBot  = !!process.env.SLACK_BOT_TOKEN;
    const hasSlackUser = !!process.env.SLACK_USER_TOKEN;
    const slack: IntegrationStatus = {
      id:            "slack",
      state:         hasSlackBot || hasSlackUser ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Microsoft 365 ───────────────────────────────────────────────────────
    let microsoft: Awaited<ReturnType<typeof getMicrosoftConnectionStatus>>;
    try {
      microsoft = await getMicrosoftConnectionStatus();
    } catch (err) {
      console.error("[integrations/status] Microsoft status check failed:", err);
      microsoft = { id: "microsoft", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Claude / Anthropic ──────────────────────────────────────────────────
    // If this route is reachable the API key is set (middleware guards the app).
    const claude: IntegrationStatus = {
      id:            "claude",
      state:         process.env.ANTHROPIC_API_KEY ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Snapshot diagnostics ────────────────────────────────────────────────
    // Module-level metadata from the persistent store — tracks last snapshot
    // attempt, success, failure, and payload size. Per-instance (resets on cold
    // start) but useful for real-time health visibility on the Settings page.
    const snapshot = getSnapshotDiagnostics();

    return NextResponse.json({ google, slack, microsoft, claude, snapshot });
  } catch (err) {
    // Top-level catch: should never fire, but ensures the settings page always
    // gets a response rather than an unhandled 500.
    console.error("[integrations/status] Unexpected error:", err);
    return NextResponse.json(
      { error: "Status check failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
