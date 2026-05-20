import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthedClient } from "@/lib/google/auth";
import { updateGmail } from "@/lib/google/watch-state";
import { verifySession, getSessionUser } from "@/lib/auth";

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

  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) {
    return NextResponse.json(
      { error: "GMAIL_PUBSUB_TOPIC not configured" },
      { status: 400 }
    );
  }

  const auth = await getAuthedClient(username);
  if (!auth) {
    return NextResponse.json({ error: "Gmail not connected" }, { status: 400 });
  }

  const gmail = google.gmail({ version: "v1", auth });
  try {
    // Fetch the authenticated account's email address so we can resolve
    // future push notifications back to this username.
    const profile = await gmail.users.getProfile({ userId: "me" });
    const watchedEmail = profile.data.emailAddress || undefined;

    const res = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: topic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    const { historyId, expiration } = res.data;
    await updateGmail(username, {
      historyId: historyId || undefined,
      expiration: expiration ? Number(expiration) : undefined,
      watchedEmail,
    });
    return NextResponse.json({
      ok: true,
      historyId,
      watchedEmail,
      expiresAt: expiration ? new Date(Number(expiration)).toISOString() : null,
    });
  } catch (e) {
    console.error("[gmail-register] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "Registration failed" },
      { status: 500 }
    );
  }
}
