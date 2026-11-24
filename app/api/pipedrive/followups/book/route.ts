/**
 * POST /api/pipedrive/followups/book { id, start } — book the follow-up meeting
 * the user picked (opt-in "schedule" mode). This sends the invite: it only
 * runs from the user's own click on a slot.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { bookFollowup, FollowupError } from "@/lib/pipedrive/followups-server";

export const maxDuration = 60;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown; start?: unknown } | null; // ci-ok: bad body → 400 below
  if (typeof body?.id !== "string" || typeof body.start !== "string") return NextResponse.json({ error: "id and start are required" }, { status: 400 });
  try {
    return NextResponse.json(await bookFollowup(username, body.id, body.start));
  } catch (e) {
    const status = e instanceof FollowupError ? e.status : 500;
    if (status === 500) console.error("[pipedrive/followups/book]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
