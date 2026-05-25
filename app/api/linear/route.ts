import { NextResponse } from "next/server";
import { isLinearConnected, getMyOpenIssues } from "@/lib/linear/client";
import { getSessionUser } from "@/lib/auth";
import { listEvents } from "@/lib/events/store";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({
      connected: false,
      issues: [],
      message: "Linear not connected. Add API key in Settings.",
    });
  }

  // Fetch issues and events concurrently. Separate try-catch so we can tell the
  // difference between a Linear API error and genuinely no issues.
  let issues: Awaited<ReturnType<typeof getMyOpenIssues>>;
  try {
    issues = await getMyOpenIssues(username);
  } catch (e) {
    console.error("[linear] getMyOpenIssues error:", e);
    return NextResponse.json({
      connected: true,   // API key is valid — the query itself failed
      issues: [],
      message: "Linear query failed — check API key permissions or try again.",
    });
  }

  const events = await listEvents(username).catch(() => []);

  // Build enrichment map: linear:<id> → analysis status
  const eventByRef = new Map<string, { analysed: boolean; materialized: boolean }>();
  for (const ev of events) {
    const ref = ev.sourceRef ?? ev.externalId;
    if (!ref) continue;
    const materialized = !!(ev.actionId || ev.decisionId || ev.memoryId ||
      ev.status === "executed" || ev.status === "approved");
    eventByRef.set(ref, { analysed: true, materialized });
  }

  // Sort: urgent (1) and high (2) first, then normal (3), then low (4), then none (0).
  // Within same priority bucket, most-recently-updated first.
  const sorted = [...issues].sort((a, b) => {
    const rank = (p: number) => (p === 0 ? 5 : p);
    const diff = rank(a.priority) - rank(b.priority);
    if (diff !== 0) return diff;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const enriched = sorted.slice(0, 25).map((issue) => {
    const ref = `linear:${issue.id}`;
    const ev = eventByRef.get(ref);
    return {
      ...issue,
      analysed: ev?.analysed ?? false,
      materialized: ev?.materialized ?? false,
    };
  });

  return NextResponse.json({
    connected: true,
    issues: enriched,
    message: enriched.length === 0 ? "No open issues assigned to you." : `${enriched.length} open issues.`,
  });
}
