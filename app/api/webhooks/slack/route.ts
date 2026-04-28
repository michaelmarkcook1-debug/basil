import { NextResponse, after } from "next/server";
import { verifySlackSignature } from "@/lib/slack/verify";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import type { IngestPayload } from "@/lib/events/types";
import { fetchSlackThread, formatThreadTranscript } from "@/lib/slack/fetch-thread";
import { classifySlack, shouldClassifySlack, shouldMaterializeSlack } from "@/lib/slack/classify-slack";
import { materializeSlackIntelligence } from "@/lib/slack/materialize-slack";

/**
 * POST /api/webhooks/slack — Slack Events API endpoint.
 *
 * Handles:
 *  - `url_verification` handshake (one-off when Slack registers the URL)
 *  - `event_callback` wrapper → inner `message` / `app_mention` events
 *
 * Security: every request is HMAC-verified against `SLACK_SIGNING_SECRET`.
 * Unverified requests are dropped silently (403).
 *
 * Set this URL in your Slack app's "Event Subscriptions" config. Required
 * scopes: channels:history, groups:history, im:history, mpim:history,
 * app_mentions:read. Enable events: message.channels, message.groups,
 * message.im, message.mpim, app_mention.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();

  // Slack sends URL verification as a plain-text JSON handshake. Respond with
  // the challenge immediately — signature check isn't required for this one.
  let parsed: UnknownSlackPayload;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (parsed?.type === "url_verification") {
    return NextResponse.json({ challenge: parsed.challenge });
  }

  // All other requests must carry a valid Slack signature.
  const ok = verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) return new NextResponse("forbidden", { status: 403 });

  // Slack expects a fast ack — we acknowledge then process async.
  // (On Vercel Fluid Compute this is fine in-line; truly long work would go
  // through Vercel Queues. For event ingestion + rule classification it's ms.)
  if (parsed.type === "event_callback" && parsed.event) {
    const inner = parsed.event;
    try {
      const payload = slackEventToIngest(inner);
      if (payload) {
        // Dedupe: webhook may redeliver on Slack's retry policy
        if (payload.externalId && (await hasExternalId(payload.externalId))) {
          return NextResponse.json({ ok: true });
        }

        const shaped = eventFromIngest(payload);
        const event = await createEvent(shaped);
        publish(event);

        // ── Slack intelligence: fire-and-forget for qualifying webhook events ──
        // Real-time DMs and mentions are the highest-signal Slack events —
        // always run intelligence on them even without poll-ingest queueing.
        const channelId = inner.channel;
        const messageTs = inner.ts;

        if (
          channelId &&
          messageTs &&
          shouldClassifySlack({
            isDM: !!payload.hints?.isDM,
            isGroupDM: !!payload.hints?.isGroupDM,
            isMention: !!payload.hints?.isMention,
            tags: event.tags,
          })
        ) {
          after(async () => {
            try {
              // TODO: resolve username from Slack team/user mapping once multi-user is fully live
              const threadMessages = await fetchSlackThread(process.env.WEBHOOK_USERNAME ?? "michael", channelId, messageTs);
              const channelName = payload.channel || payload.title || "Slack";
              const transcript =
                threadMessages.length > 0
                  ? formatThreadTranscript(threadMessages, channelName)
                  : `Channel: ${channelName}\n\n${payload.from || "Unknown"}: ${payload.body || ""}`;

              // Use the Slack event timestamp for accurate provenance dating.
              // inner.ts is a Unix epoch in seconds (with decimal ms component).
              const messageDate = inner.ts
                ? new Date(parseFloat(inner.ts) * 1000).toISOString()
                : new Date().toISOString();

              const intel = await classifySlack({
                channelName,
                transcript,
                isDM: !!payload.hints?.isDM,
                isMention: !!payload.hints?.isMention,
                date: messageDate,
              });

              if (!shouldMaterializeSlack(intel)) return;

              const result = await materializeSlackIntelligence({
                intelligence: intel,
                sourceRef: payload.externalId || `slack:${channelId}:${messageTs}`,
                eventId: event.id,
                channelName,
                from: payload.from || "Unknown",
                date: messageDate,
              });

            } catch (err) {
              console.error("[webhook/slack] intelligence failed:", err);
            }
          });
        }
      }
    } catch (e) {
      console.error("Slack event handling error:", e);
    }
  }

  return NextResponse.json({ ok: true });
}

interface UnknownSlackPayload {
  type?: string;
  challenge?: string;
  event?: SlackInnerEvent;
}

interface SlackInnerEvent {
  type: string;
  channel?: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
}

function slackEventToIngest(e: SlackInnerEvent): IngestPayload | null {
  // Ignore bot messages and message edits/deletes — focus on human signal
  if (e.bot_id) return null;
  if (e.subtype) return null;

  const isMessageOrMention =
    e.type === "message" || e.type === "app_mention";
  if (!isMessageOrMention) return null;

  const text = e.text || "";
  const isDM = e.channel_type === "im";
  const isGroupDM = e.channel_type === "mpim";
  const isMention =
    e.type === "app_mention" || /<@[A-Z0-9]+>/i.test(text);

  return {
    source: "slack",
    // Stable external id for dedup — same format as poll-ingest
    externalId: e.channel && e.ts ? `slack:${e.channel}:${e.ts}` : undefined,
    title: isDM
      ? "Slack DM"
      : isGroupDM
        ? "Slack Group DM"
        : `Slack ${e.channel || "channel"}`,
    body: text,
    from: e.user,
    channel: e.channel,
    hints: {
      isDM,
      isGroupDM,
      isMention,
    },
  };
}
