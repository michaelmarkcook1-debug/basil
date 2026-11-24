/** POST /api/pipedrive/followups/slots { id } — free times for a follow-up (opt-in "schedule" mode). */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { followupSlots, FollowupError } from "@/lib/pipedrive/followups-server";

export const maxDuration = 60;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown } | null; // ci-ok: bad body → 400 below
  if (typeof body?.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    return NextResponse.json(await followupSlots(username, body.id));
  } catch (e) {
    const status = e instanceof FollowupError ? e.status : 500;
    if (status === 500) console.error("[pipedrive/followups/slots]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
