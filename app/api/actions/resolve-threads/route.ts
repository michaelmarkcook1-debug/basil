/**
 * POST /api/actions/resolve-threads — close actions whose conversation moved on.
 *
 * The Actions page calls this when it opens, so the list tidies itself when
 * the user looks at it instead of only at the 05:45 ingest run. Each action is
 * re-read at most once per RECHECK_AFTER_HOURS, so repeat visits cost nothing.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { resolveThreadActions } from "@/lib/actions/resolve-threads";

export const dynamic = "force-dynamic";
// Up to 40 conversations × (2 Gmail/Slack calls + occasionally a small model call).
export const maxDuration = 120;

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const { checked, closed } = await resolveThreadActions(username);
    return NextResponse.json({ checked, closed: closed.length });
  } catch (err) {
    console.error("[actions/resolve-threads] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not check conversations" }, { status: 500 });
  }
}
