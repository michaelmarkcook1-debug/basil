import { NextResponse } from "next/server";
import { verifySession, getSessionUser } from "@/lib/auth";
import { registerGmailPush } from "@/lib/google/register-webhooks";

/**
 * POST /api/webhooks/gmail/register — one-shot registration for Gmail push.
 *
 * Requires env:
 *   GMAIL_PUBSUB_TOPIC  — `projects/<gcp-project>/topics/<topic>`
 *                         (topic must have pubsub.publisher granted to
 *                          gmail-api-push@system.gserviceaccount.com)
 *
 * Gmail expires watch channels after 7 days — the cron renews via this endpoint.
 * The user's Gmail address is stored in watchedEmail so inbound push
 * notifications can be resolved back to this username.
 */
/** GET — browser-friendly alias for the POST handler. */
export async function GET() {
  return POST();
}

export async function POST() {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await registerGmailPush(username);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not configured") || msg.includes("not connected")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error("[gmail-register] failed:", msg);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
