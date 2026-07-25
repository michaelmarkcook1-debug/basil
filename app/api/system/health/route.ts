/**
 * GET /api/system/health
 *
 * Aggregates connection state, webhook health, and data freshness for every
 * integration.  All checks run concurrently; the response always includes a
 * full report even when individual checks fail (they degrade to grey/red tiles).
 *
 * Returns { SystemHealthReport } — see lib/system/health.ts for the shape.
 *
 * Performance: cold-start ~1-2s (Google/MS token refresh), warm ~200ms.
 * The settings page polls this every 60s; no caching layer needed here.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { gatherSystemHealth } from "@/lib/system/health";
import { isDistributedLock } from "@/lib/storage/lock";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // NOTE: we intentionally do NOT gate on validateModelConfig() here.
  // A misconfigured AI provider is one tile in the health report — it must not
  // prevent all other tiles (storage, integrations, data freshness) from rendering.
  // The model config state is surfaced as a check inside gatherSystemHealth itself.

  try {
    const report = await gatherSystemHealth(username);
    // Surface whether locking is genuinely cross-instance. isDistributedLock()
    // existed but was consumed NOWHERE, so there was no way to tell that every
    // withLock in production had silently degraded to a per-instance mutex —
    // which is exactly how the lost-update exposure stayed invisible.
    return NextResponse.json({ ...report, distributedLock: isDistributedLock() });
  } catch (err) {
    console.error("[system/health] Unexpected error:", err);
    return NextResponse.json(
      {
        error: "Health check failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
