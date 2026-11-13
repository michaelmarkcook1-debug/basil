/** POST /api/notify/test — send a test notification to every device the user turned on. */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isPushConfigured, notifyUser } from "@/lib/notify";
import { checkRateLimitDurable } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isPushConfigured()) return NextResponse.json({ error: "Push notifications are not set up on this Basil yet." }, { status: 503 });
  const limit = await checkRateLimitDurable(`notify-test:${username.toLowerCase()}`, 5, "1 h");
  if (!limit.allowed) return NextResponse.json({ error: "That's enough tests for now. Try again in an hour." }, { status: 429 });
  const outcome = await notifyUser(username, {
    kind: "test",
    title: "Basil notifications are on",
    body: "This is what a reminder from Basil looks like.",
    url: "/dashboard/settings?tab=profile#notifications",
    tag: "basil-test",
  });
  return NextResponse.json({ ok: outcome.pushed > 0, pushed: outcome.pushed });
}
