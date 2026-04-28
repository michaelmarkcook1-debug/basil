import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthedClient } from "@/lib/google/auth";
import { updateGmail } from "@/lib/google/watch-state";

/**
 * POST /api/webhooks/gmail/register — one-shot registration for Gmail push.
 *
 * Requires env:
 *   GMAIL_PUBSUB_TOPIC  — `projects/<gcp-project>/topics/<topic>`
 *                         (topic must have pubsub.publisher granted to
 *                          gmail-api-push@system.gserviceaccount.com)
 *
 * Gmail expires watch channels after 7 days — the cron renews via this endpoint.
 */
export async function POST() {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) {
    return NextResponse.json(
      { error: "GMAIL_PUBSUB_TOPIC not configured" },
      { status: 400 }
    );
  }

  // TODO: resolve username from session once multi-user is fully live
  const auth = await getAuthedClient(process.env.WEBHOOK_USERNAME ?? "michael");
  if (!auth) {
    return NextResponse.json({ error: "Gmail not connected" }, { status: 400 });
  }

  const gmail = google.gmail({ version: "v1", auth });
  try {
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: topic,
        labelIds: ["INBOX"],
        labelFilterBehavior: "INCLUDE",
      },
    });
    const { historyId, expiration } = res.data;
    await updateGmail({
      historyId: historyId || undefined,
      expiration: expiration ? Number(expiration) : undefined,
    });
    return NextResponse.json({
      ok: true,
      historyId,
      expiresAt: expiration ? new Date(Number(expiration)).toISOString() : null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
