/**
 * POST /api/actions/resolve-threads — close actions that are already settled.
 *
 * Two passes: the source conversation moved on (lib/actions/resolve-threads.ts),
 * and the ask was done elsewhere or its moment passed (lib/actions/check-done.ts).
 * Today and the Actions page call this when they open, so the list tidies
 * itself when the user looks at it instead of only at the 05:45 ingest run.
 * Each action is looked at most once a day per pass, so repeat visits cost nothing.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { resolveThreadActions } from "@/lib/actions/resolve-threads";
import { checkDoneActions } from "@/lib/actions/check-done";

export const dynamic = "force-dynamic";
// Up to 40 conversations × (2 Gmail/Slack calls + occasionally a small model call).
export const maxDuration = 180;

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const threads = await resolveThreadActions(username);
    // The second pass runs even if it finds nothing new in threads; its own
    // failure must not hide what the first pass closed.
    const done = await checkDoneActions(username).catch((err) => {
      console.error("[actions/resolve-threads] done-check failed:", err instanceof Error ? err.message : err);
      return { checked: 0, closed: [] as { id: string; text: string; state: "done" | "expired"; reason: string }[] };
    });
    return NextResponse.json({
      checked: threads.checked + done.checked,
      closed: threads.closed.length + done.closed.length,
      closedItems: [
        ...threads.closed.map((c) => ({ id: c.action.id, text: c.action.text, why: c.resolution.kind })),
        ...done.closed.map((c) => ({ id: c.id, text: c.text, why: c.state, reason: c.reason })),
      ],
    });
  } catch (err) {
    console.error("[actions/resolve-threads] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not check conversations" }, { status: 500 });
  }
}
