import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { readTraces, computeDispatchMetrics } from "@/core/dispatch/dispatcher";
import type { DispatchIntent } from "@/core/primitives/dispatch-request";

/**
 * GET /api/admin/dispatch-log
 *
 * Returns recent dispatch traces + aggregate metrics.
 * Admin-only endpoint.
 *
 * Query params:
 *   intent   — filter by DispatchIntent (e.g. classify_email, classify_slack)
 *   status   — filter by trace status (success | validation_error | provider_error)
 *   limit    — max traces to return (default 50, max 200)
 *   metrics  — "1" to include aggregate metrics in the response
 *
 * Response:
 * {
 *   traces: DispatchTrace[],
 *   total: number,
 *   metrics?: { total, successRate, avgLatencyMs, errorCount, byIntent }
 * }
 */

export async function GET(req: NextRequest) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = req.nextUrl;

  const intent    = searchParams.get("intent") ?? undefined;
  const status    = searchParams.get("status") ?? undefined;
  const limitParam = parseInt(searchParams.get("limit") ?? "50", 10);
  const includeMetrics = searchParams.get("metrics") === "1";

  const limit = Math.min(Math.max(1, Number.isNaN(limitParam) ? 50 : limitParam), 200);

  const traces = await readTraces(username, {
    intent: intent as DispatchIntent | undefined,
    status: status as "success" | "validation_error" | "provider_error" | undefined,
    limit,
  });

  const response: Record<string, unknown> = {
    traces,
    total: traces.length,
  };

  if (includeMetrics) {
    // Metrics reflect the last 7 days of dispatch activity ("current health") so a
    // rolling 1000-call log can't keep showing long-resolved historical failures.
    // The full log is still read for the trace list below; only the metric is scoped.
    const allTraces = await readTraces(username, { limit: 1000 });
    response.metrics = computeDispatchMetrics(allTraces, 7);
  }

  console.info(
    `[admin/dispatch-log] ${username} intent=${intent ?? "all"} status=${status ?? "all"} ` +
    `returned=${traces.length} metrics=${includeMetrics}`
  );

  return NextResponse.json(response);
}
