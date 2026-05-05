import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthedClient } from "@/lib/google/auth";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { getWatchState, updateGmail } from "@/lib/google/watch-state";
import { detectZoomEmail } from "@/lib/google/zoom-email-detector";
import { start } from "workflow/api";
import { ingestGmailWorkflow } from "@/lib/jobs/workflows/ingest-gmail";
import { createJobRecord } from "@/lib/jobs/store";
import { resolveGmailUser } from "@/lib/webhooks/resolve-user";
import { writeDeadLetter } from "@/lib/webhooks/dead-letter";

/**
 * POST /api/webhooks/gmail — Gmail push notifications (via Cloud Pub/Sub).
 *
 * Architecture:
 *  1. `users.watch` was called once (see /api/webhooks/gmail/register) to
 *     register this endpoint for a Pub/Sub topic.
 *  2. Pub/Sub delivers push messages here containing only `{ emailAddress,
 *     historyId }` — NOT the message content. This is by design.
 *  3. We call `users.history.list(startHistoryId=last seen)` to get the diff,
 *     then fetch each added message and hand it to the Basil rules engine.
 *  4. Pub/Sub retries unless we 2xx, so we finish the diff before responding.
 *
 * Security: Pub/Sub push requests can be authenticated by requiring an
 * `Authorization: Bearer <token>` header with a Google-signed JWT, verified
 * against `GMAIL_PUBSUB_AUDIENCE`. We verify a shared `GMAIL_PUBSUB_TOKEN`
 * query param as a simpler alternative — set both in the Pub/Sub subscription.
 *
 * Zoom detection: messages identified as Zoom meeting summaries get
 * source:"zoom_email" rather than source:"email". The raw From header
 * is available here (before the display-name extraction that poll-ingest
 * applies), giving more reliable domain-based detection.
 */
export async function POST(req: Request) {
  // Lightweight auth: shared secret in the push URL.
  // Note: urlParams comes from the native URL API (synchronous) — not Next.js route searchParams.
  const urlParams = new URL(req.url).searchParams;
  const secretToken = urlParams.get("token");
  if (
    process.env.GMAIL_PUBSUB_TOKEN &&
    secretToken !== process.env.GMAIL_PUBSUB_TOKEN
  ) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as PubSubEnvelope | null; // ci-ok: malformed webhook body returns null, drained below
  const dataB64 = body?.message?.data;
  if (!dataB64) return NextResponse.json({ ok: true }); // invalid but drain

  let payload: { emailAddress?: string; historyId?: string };
  try {
    payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
  } catch {
    return NextResponse.json({ ok: true });
  }

  const newHistoryId = payload.historyId;
  if (!newHistoryId) return NextResponse.json({ ok: true });

  // Resolve the owning user from the notification's emailAddress.
  const emailAddress = payload.emailAddress ?? "";
  const webhookUsername = await resolveGmailUser(emailAddress);
  if (!webhookUsername) {
    await writeDeadLetter("gmail", payload, `No user found for emailAddress: ${emailAddress}`);
    return NextResponse.json({ ok: true, note: "unresolved owner" });
  }

  const auth = await getAuthedClient(webhookUsername);
  if (!auth) return NextResponse.json({ ok: true, note: "gmail not connected" });
  const gmail = google.gmail({ version: "v1", auth });

  const state = await getWatchState(webhookUsername);
  const startHistoryId = state.gmail?.historyId;

  // No baseline yet — just record the current id and wait for the next push.
  if (!startHistoryId) {
    await updateGmail(webhookUsername, { historyId: newHistoryId });
    return NextResponse.json({ ok: true, bootstrapped: true });
  }

  let processed = 0;

  try {
    const hist = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      maxResults: 50,
    });

    const added = new Set<string>();
    for (const h of hist.data.history || []) {
      for (const m of h.messagesAdded || []) {
        if (m.message?.id) added.add(m.message.id);
      }
    }

    for (const id of added) {
      try {
        // Skip if already ingested (e.g. poll-ingest ran first)
        const externalId = `gmail:${id}`;
        if (await hasExternalId(externalId)) continue;

        const detail = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "Subject"],
        });
        const headers = detail.data.payload?.headers || [];
        const h = (n: string) =>
          headers.find((hh) => hh.name === n)?.value || "";

        const fromRaw = h("From");
        const subject = h("Subject");
        const snippet = detail.data.snippet || "";

        // Zoom detection: use the raw From header (includes domain) for reliable detection.
        const zoomSignal = detectZoomEmail({
          from: fromRaw,
          subject,
          snippet,
        });
        const source = zoomSignal.isZoom ? "zoom_email" as const : "email" as const;

        const shaped = eventFromIngest({
          source,
          externalId,
          title: subject || "(no subject)",
          body: snippet,
          from: extractName(fromRaw),
        });
        const event = await createEvent(shaped);
        publish(event);
        processed++;

        const gmailPayload = source === "zoom_email"
          ? {
              gmailId: id,
              externalId,
              eventId: event.id,
              subject: subject || "(no subject)",
              from: extractName(fromRaw),
              isZoom: true as const,
            }
          : {
              gmailId: id,
              externalId,
              eventId: event.id,
              subject: subject || "(no subject)",
              from: extractName(fromRaw),
              isZoom: false as const,
              snippetFallback: snippet,
            };
        void createJobRecord(webhookUsername, "ingest.gmail", externalId);
        await start(ingestGmailWorkflow, [webhookUsername, gmailPayload]);
      } catch (e) {
        console.error("Gmail message fetch failed:", e instanceof Error ? e.message : e);
      }
    }

    await updateGmail(webhookUsername, { historyId: newHistoryId });
    return NextResponse.json({ ok: true, processed });
  } catch (e) {
    // On 404 HISTORY_NOT_FOUND (startHistoryId too old) just reset baseline.
    console.error("Gmail history.list error:", e instanceof Error ? e.message : e);
    await updateGmail(webhookUsername, { historyId: newHistoryId });
    return NextResponse.json({ ok: true, reset: true });
  }
}

// "Malcolm Frank <malcolm@ex.com>" → "Malcolm Frank"
function extractName(from: string): string {
  const m = from.match(/^(.+?)\s*<.+>$/);
  return (m?.[1] || from).replace(/^"|"$/g, "").trim();
}

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}
