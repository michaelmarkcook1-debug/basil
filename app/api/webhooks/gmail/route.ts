import { NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthedClient } from "@/lib/google/auth";
import { createEventIfNew, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { getWatchState, updateGmail } from "@/lib/google/watch-state";
import { detectZoomEmail } from "@/lib/google/zoom-email-detector";
import { triageEmail } from "@/lib/email/triage";
import { loadKnownSenders, type KnownSenders } from "@/lib/email/known-senders";
import { isBulkMail } from "@/lib/google/gmail";
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
  const expectedToken = process.env.GMAIL_PUBSUB_TOKEN;
  if (!expectedToken) {
    // Fail closed: with no configured secret, anyone could POST forged Pub/Sub
    // envelopes. Reject until GMAIL_PUBSUB_TOKEN is set rather than accepting
    // unauthenticated webhooks.
    console.error("[webhooks/gmail] GMAIL_PUBSUB_TOKEN not configured — rejecting webhook (fail closed).");
    return new NextResponse("webhook not configured", { status: 503 });
  }
  if (secretToken !== expectedToken) {
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
  // Messages we could not ingest this delivery. Any at all → the baseline stays
  // put and Pub/Sub redelivers; createEventIfNew makes the retry safe.
  let failed = 0;

  try {
    // Read the WHOLE delta. history.list returns at most maxResults records per
    // call; the single call this replaced read the first 50 and then moved the
    // baseline past everything after them, so a burst of mail was never seen.
    const added = new Set<string>();
    let pageToken: string | undefined;
    let pages = 0;
    let lastHistoryId: string | undefined;
    do {
      const hist = await gmail.users.history.list({
        userId: "me",
        startHistoryId,
        historyTypes: ["messageAdded"],
        maxResults: 100,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const h of hist.data.history || []) {
        if (h.id) lastHistoryId = h.id;
        for (const m of h.messagesAdded || []) {
          if (m.message?.id) added.add(m.message.id);
        }
      }
      pageToken = hist.data.nextPageToken || undefined;
      pages++;
    } while (pageToken && pages < MAX_HISTORY_PAGES);
    // Hit the page cap (thousands of records): advance only as far as we read,
    // so the next push resumes from there instead of skipping the rest.
    const complete = !pageToken;

    // Fetch message metadata in parallel batches of 5 to stay well within
    // Gmail API rate limits while avoiding the latency of sequential fetches.
    // Pub/Sub has a ~10 s ACK deadline — sequential fetches on 50 messages
    // would consistently time out on busy inboxes.
    const addedIds = [...added];
    let knownSenders: Promise<KnownSenders> | undefined;
    const BATCH_SIZE = 5;
    for (let i = 0; i < addedIds.length; i += BATCH_SIZE) {
      await Promise.all(addedIds.slice(i, i + BATCH_SIZE).map(async (id) => {
        try {
          // Skip if already ingested (e.g. poll-ingest ran first)
          const externalId = `gmail:${id}`;
          if (await hasExternalId(webhookUsername, externalId)) return;

          const detail = await gmail.users.messages.get({
            userId: "me",
            id,
            format: "metadata",
            metadataHeaders: ["From", "Subject", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"],
          });
          const labels = detail.data.labelIds || [];
          // The history delta can carry the user's own sent mail; Basil only
          // ingests inbound (mirrors poll-ingest's in:inbox + isSelf).
          if (labels.includes("SENT") && !labels.includes("INBOX")) return;
          const headers = detail.data.payload?.headers || [];
          const h = (n: string) =>
            headers.find((hh) => hh.name?.toLowerCase() === n.toLowerCase())?.value || "";

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

          // Aggressive junk gate (mirrors poll-ingest) — don't create events for
          // empty/"Test", no-reply, or marketing mail. Zoom recaps bypass it.
          if (source === "email") {
            const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] || fromRaw).trim();
            const known = await (knownSenders ??= loadKnownSenders(webhookUsername));
            const triage = triageEmail({
              from: fromRaw, fromEmail, subject, snippet,
              labels, bulk: isBulkMail(h), knownSender: known.isKnown(fromEmail),
            });
            if (triage.lowValue) return; // skip this message (per-id async callback)
          }

          const shaped = eventFromIngest({
            source,
            externalId,
            title: subject || "(no subject)",
            body: snippet,
            from: extractName(fromRaw),
          });
          // The check above ran outside the lock; this one is authoritative, so a
          // redelivery or poll-ingest racing us cannot create a second event.
          const { created, event } = await createEventIfNew(webhookUsername, shaped);
          if (!created) return;
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
        } catch (err) {
          // Deleted between the history entry and this fetch: nothing to ingest,
          // and retrying would never succeed — not a failure.
          if (httpStatus(err) === 404) return;
          failed++;
          console.error(`[gmail-webhook] message fetch failed id=${id}:`, err instanceof Error ? err.message : err);
        }
      }));
    }

    if (failed > 0) {
      // Advancing now would skip the failed messages for good. Keep the old
      // baseline and let Pub/Sub redeliver; the ones already ingested are
      // deduped by externalId on the retry.
      console.error(
        `[gmail-webhook] ${failed} of ${addedIds.length} message(s) failed for ${webhookUsername} — NOT advancing baseline`
      );
      return NextResponse.json({ ok: false, processed, failed, error: "some messages failed — will retry" }, { status: 503 });
    }

    const nextBaseline = complete ? newHistoryId : lastHistoryId;
    if (nextBaseline) await updateGmail(webhookUsername, { historyId: nextBaseline });
    return NextResponse.json({ ok: true, processed, ...(complete ? {} : { partial: true }) });
  } catch (e) {
    const status = httpStatus(e);
    const msg = e instanceof Error ? e.message : String(e);
    const isHistoryGone =
      status === 404 || /HISTORY_NOT_FOUND|not found/i.test(msg);

    if (isHistoryGone) {
      // Baseline too old — Gmail dropped the history window. We can't recover the
      // gap, but advancing to the new historyId lets future deltas flow.
      console.warn(`[gmail-webhook] history baseline too old for ${webhookUsername} — resetting to ${newHistoryId}`);
      await updateGmail(webhookUsername, { historyId: newHistoryId });
      return NextResponse.json({ ok: true, reset: true });
    }

    // Transient error (Google 5xx, timeout, token refresh hiccup). Do NOT
    // advance the baseline — that would PERMANENTLY skip every message in this
    // history window. Return 5xx so Pub/Sub redelivers.
    console.error(`[gmail-webhook] transient history.list error for ${webhookUsername} — NOT advancing baseline:`, msg);
    return NextResponse.json({ ok: false, error: "transient — will retry" }, { status: 503 });
  }
}

/** Safety stop for the history pager: 20 × 100 records per push. */
const MAX_HISTORY_PAGES = 20;

/**
 * HTTP status from a googleapis error, whichever field it arrived in. `code`
 * can also be a network code ("ECONNRESET") or a numeric string, so only a
 * three-digit status counts.
 */
function httpStatus(e: unknown): number | undefined {
  const x = e as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  for (const v of [x?.code, x?.status, x?.response?.status]) {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d{3}$/.test(v) ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// "Jordan Avery <jordan@ex.com>" → "Jordan Avery"
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
