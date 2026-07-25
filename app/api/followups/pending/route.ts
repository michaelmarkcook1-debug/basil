import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { detectPendingFollowups } from "@/lib/followups/detect";

/**
 * GET /api/followups/pending
 *
 * Threads/DMs awaiting the user's reply (Gmail + Slack). Per-user, session-gated;
 * no caching (data is private and time-sensitive).
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const result = await detectPendingFollowups(username);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[followups/pending]", err);
    return NextResponse.json({ error: "Failed to detect pending follow-ups." }, { status: 500 });
  }
}
