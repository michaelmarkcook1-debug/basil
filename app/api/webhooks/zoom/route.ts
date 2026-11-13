import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { createEventIfNew, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { resolveZoomUser } from "@/lib/webhooks/resolve-user";
import { writeDeadLetter } from "@/lib/webhooks/dead-letter";
import { start } from "workflow/api";
import { ingestZoomWorkflow } from "@/lib/jobs/workflows/ingest-zoom";
import { createJobRecord } from "@/lib/jobs/store";

/**
 * POST /api/webhooks/zoom — Zoom Events API endpoint.
 *
 * Handles:
 *  - `endpoint.url_validation` handshake (one-off when Zoom registers the URL)
 *  - `meeting.ended`                — process meeting immediately after it ends
 *  - `recording.completed`          — recording files ready
 *  - `recording.transcript_completed` — AI-generated transcript ready
 *
 * Setup in Zoom Marketplace app:
 *  1. Add "Event Subscriptions" feature to your Zoom app
 *  2. Set notification URL: https://basil-app.vercel.app/api/webhooks/zoom
 *  3. Subscribe to: meeting.ended, recording.completed,
 *     recording.transcript_completed
 *  4. Copy the "Secret Token" from the Event Subscriptions page into
 *     ZOOM_WEBHOOK_SECRET_TOKEN env var.
 *
 * Security: all requests are verified via HMAC-SHA256 using the secret token.
 * The URL validation challenge also uses HMAC-SHA256.
 */

// ── Signature verification ────────────────────────────────────────────────────

function verifyZoomSignature(opts: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
}): boolean {
  const { secret, signature, timestamp, rawBody } = opts;
  if (!signature || !timestamp) return false;

  // Zoom signature format: "v0=<hex>"
  const message = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(message).digest("hex")}`;
  return expected === signature;
}

// ── User resolution ───────────────────────────────────────────────────────────

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  let parsed: ZoomWebhookPayload;
  try {
    parsed = JSON.parse(rawBody) as ZoomWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // ── URL validation challenge (no signature required) ──────────────────────
  if (parsed.event === "endpoint.url_validation") {
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
    const plainToken = parsed.payload?.plainToken;
    if (!secret || !plainToken) {
      return NextResponse.json({ error: "ZOOM_WEBHOOK_SECRET_TOKEN not configured" }, { status: 500 });
    }
    const encryptedToken = createHmac("sha256", secret).update(plainToken).digest("hex");
    return NextResponse.json({ plainToken, encryptedToken });
  }

  // ── Verify signature on all other requests ────────────────────────────────
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (secret) {
    const ok = verifyZoomSignature({
      secret,
      signature: req.headers.get("x-zm-signature"),
      timestamp: req.headers.get("x-zm-request-timestamp"),
      rawBody,
    });
    if (!ok) {
      return new NextResponse("forbidden", { status: 403 });
    }
  } else {
    // Fail CLOSED when the secret is unset: without signature verification anyone
    // can POST forged meeting data that gets materialised into a real user's
    // stores. Only bypass in a genuine local-dev environment.
    const isProd = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
    if (isProd) {
      console.error("[zoom-webhook] ZOOM_WEBHOOK_SECRET_TOKEN not set in production — rejecting unverifiable event");
      return new NextResponse("webhook not configured", { status: 503 });
    }
    console.warn("[zoom-webhook] ZOOM_WEBHOOK_SECRET_TOKEN not set — skipping signature verification (dev only)");
  }

  const event = parsed.event;
  const obj   = parsed.payload?.object;

  if (!event || !obj) return NextResponse.json({ ok: true });

  // ── Resolve the owning user ───────────────────────────────────────────────
  const hostEmail = obj.host_email;
  const webhookUsername = await resolveZoomUser(hostEmail);

  if (!webhookUsername) {
    await writeDeadLetter("zoom", { event, meetingId: obj.id }, "No user has Zoom connected");
    return NextResponse.json({ ok: true });
  }

  // ── Handle events ─────────────────────────────────────────────────────────
  const handledEvents = new Set([
    "meeting.ended",
    "recording.completed",
    "recording.transcript_completed",
  ]);

  if (!handledEvents.has(event)) {
    // Acknowledge unhandled event types silently — Zoom retries non-2xx
    return NextResponse.json({ ok: true });
  }

  const meetingId = String(obj.id ?? "");
  if (!meetingId) return NextResponse.json({ ok: true });

  const externalId = `zoom-api:${meetingId}`;

  // Dedupe: don't re-ingest a meeting we've already processed
  const alreadyProcessed = await hasExternalId(webhookUsername, externalId);

  // For transcript_completed we always want to re-process even if meeting.ended
  // already ran, because the transcript wasn't available yet.
  const forceReprocess = event === "recording.transcript_completed";

  if (alreadyProcessed && !forceReprocess) {
    console.log(`[zoom-webhook] ${event} meetingId=${meetingId} already ingested — skipping`);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Create a BasilEvent stub so the UI shows something immediately — or find
  // the one that exists. meeting.ended and recording.completed arrive back to
  // back and both pass the check above; createEventIfNew re-checks inside the
  // lock so only one of them creates the event and starts the workflow.
  let basilEventId: string | undefined;
  try {
    const topic = obj.topic ?? "Zoom Meeting";
    const shaped = eventFromIngest({
      source: "zoom",
      externalId,
      title: topic,
      body: `${event === "meeting.ended" ? "Meeting ended" : "Recording available"}: ${topic}`,
    });
    const { created, event: basilEvent } = await createEventIfNew(webhookUsername, shaped);
    if (created) {
      publish(basilEvent);
    } else if (!forceReprocess) {
      console.log(`[zoom-webhook] ${event} meetingId=${meetingId} already ingested — skipping`);
      return NextResponse.json({ ok: true, skipped: true });
    }
    // Pass the existing event on a transcript re-run too: with an empty id the
    // workflow created a second event for the same meeting.
    basilEventId = basilEvent.id;
  } catch (e) {
    console.error("[zoom-webhook] createEvent failed:", e instanceof Error ? e.message : e);
  }

  // Kick off durable workflow to fetch full meeting data and run intelligence pipeline
  try {
    void createJobRecord(webhookUsername, "ingest.zoom", externalId);
    await start(ingestZoomWorkflow, [
      webhookUsername,
      { meetingId, externalId, eventId: basilEventId ?? "" },
    ]);
    console.log(`[zoom-webhook] ${event} meetingId=${meetingId} → workflow started for ${webhookUsername}`);
  } catch (e) {
    console.error("[zoom-webhook] workflow start failed:", e instanceof Error ? e.message : e);
  }

  return NextResponse.json({ ok: true });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ZoomWebhookPayload {
  event?: string;
  payload?: {
    /** Present on endpoint.url_validation only */
    plainToken?: string;
    /** Present on meeting and recording events */
    object?: ZoomEventObject;
  };
  event_ts?: number;
}

interface ZoomEventObject {
  id?: string | number;
  uuid?: string;
  topic?: string;
  host_id?: string;
  host_email?: string;
  duration?: number;
  start_time?: string;
  /** Present on recording events */
  recording_files?: Array<{ file_type?: string; download_url?: string }>;
}
