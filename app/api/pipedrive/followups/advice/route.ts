/** POST /api/pipedrive/followups/advice { id, fresh? } — how to follow up: when, channel, what to say/do/avoid. */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { adviceForFollowup } from "@/lib/psychology/followup-advice";

export const maxDuration = 60;

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { id?: unknown; fresh?: unknown } | null; // ci-ok: bad body → 400 below
  if (typeof body?.id !== "string") return NextResponse.json({ error: "id is required" }, { status: 400 });
  try {
    return NextResponse.json({ advice: await adviceForFollowup(username, body.id, { fresh: body.fresh === true }) });
  } catch (e) {
    console.warn("[pipedrive/followups/advice]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
