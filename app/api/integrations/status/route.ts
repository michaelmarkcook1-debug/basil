import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getMicrosoftConnectionStatus } from "@/lib/microsoft/auth";
import { isSlackConnected } from "@/lib/slack/client";
import { isLinearConnected } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getSnapshotDiagnostics } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";
import type { IntegrationStatus } from "@/lib/integrations/types";

/**
 * GET /api/integrations/status
 *
 * Returns the concrete connection state for every integration, scoped to the
 * logged-in user.  Each check reads from the persistent store — no external
 * API calls are made — so it resolves quickly and never hangs.
 */
export async function GET() {
  const now = new Date().toISOString();
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

    // ── Slack ───────────────────────────────────────────────────────────────
    let slack: IntegrationStatus;
    try {
      const slackConnected = await isSlackConnected(username);
      slack = { id: "slack", state: slackConnected ? "connected" : "disconnected", lastCheckedAt: now };
    } catch (err) {
      console.error("[integrations/status] Slack status check failed:", err);
      slack = { id: "slack", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Microsoft 365 ───────────────────────────────────────────────────────
    let microsoft: Awaited<ReturnType<typeof getMicrosoftConnectionStatus>>;
    try {
      microsoft = await getMicrosoftConnectionStatus(username);
    } catch (err) {
      console.error("[integrations/status] Microsoft status check failed:", err);
      microsoft = { id: "microsoft", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Linear ──────────────────────────────────────────────────────────────
    let linear: IntegrationStatus;
    try {
      const linearConnected = await isLinearConnected(username);
      linear = { id: "linear", state: linearConnected ? "connected" : "disconnected", lastCheckedAt: now };
    } catch (err) {
      console.error("[integrations/status] Linear status check failed:", err);
      linear = { id: "linear", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Claude / Anthropic ──────────────────────────────────────────────────
    const claude: IntegrationStatus = {
      id:            "claude",
      state:         process.env.ANTHROPIC_API_KEY ? "connected" : "disconnected",
      lastCheckedAt: now,
    };

    // ── Zoom ────────────────────────────────────────────────────────────────
    let zoom: IntegrationStatus;
    try {
      const zoomConnected = await isZoomConnected(username);
      zoom = { id: "zoom", state: zoomConnected ? "connected" : "disconnected", lastCheckedAt: now };
    } catch (err) {
      console.error("[integrations/status] Zoom status check failed:", err);
      zoom = { id: "zoom", state: "error", lastCheckedAt: now, error: err instanceof Error ? err.message : String(err) };
    }

    // ── Snapshot diagnostics ────────────────────────────────────────────────
    const snapshot = getSnapshotDiagnostics();

    return NextResponse.json({ google, slack, microsoft, linear, claude, zoom, snapshot });
  } catch (err) {
    console.error("[integrations/status] Unexpected error:", err);
    return NextResponse.json(
      { error: "Status check failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
