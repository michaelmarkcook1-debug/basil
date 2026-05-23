import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { readShadowComparisons, computeParityMetrics } from "@/core/ingestion/shadow-runner";

/**
 * GET /api/admin/shadow-log
 *
 * Returns recent shadow comparisons and parity metrics.
 *
 * Query params:
 *   limit  — number of entries to return (default 50, max 200)
 *   stats  — "1" to include parity metrics in the response
 *
 * Response:
 * {
 *   comparisons: ShadowComparison[],   // most-recent first
 *   metrics?: {
 *     total: number,
 *     matches: number,
 *     exactMatchRate: number,          // 0-1
 *     criticalDiffs: number,
 *     criticalDiffRate: number,        // 0-1
 *     normalizerErrors: number,
 *     paritySatisfied: boolean,        // true when rate ≥ 0.90 and criticalRate < 0.02
 *   }
 * }
 *
 * Requires admin auth. Uses fresh read (no cache) since this is an audit route.
 */
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 50 : limitParam), 200);
  const includeStats = searchParams.get("stats") === "1";

  let comparisons;
  try {
    comparisons = await readShadowComparisons(username, limit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shadow-log] read failed for ${username}:`, msg);
    return NextResponse.json({ error: "Failed to read shadow log" }, { status: 500 });
  }

  console.info(`[shadow-log] ${username} read ${comparisons.length} entries in ${Date.now() - t0}ms`);

  const body: Record<string, unknown> = { comparisons };

  if (includeStats) {
    const metrics = computeParityMetrics(comparisons);
    const EXACT_MATCH_THRESHOLD = 0.90;
    const CRITICAL_DIFF_THRESHOLD = 0.02;
    body.metrics = {
      ...metrics,
      paritySatisfied:
        metrics.total > 0 &&
        metrics.exactMatchRate >= EXACT_MATCH_THRESHOLD &&
        metrics.criticalDiffRate < CRITICAL_DIFF_THRESHOLD,
    };
  }

  return NextResponse.json(body);
}
