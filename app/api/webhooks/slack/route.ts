import { NextResponse } from "next/server";
import { verifySlackSignature } from "@/lib/slack/verify";
import { createEvent, hasExternalId } from "@/lib/events/store";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import type { IngestPayload } from "@/lib/events/types";
import { shouldClassifySlack } from "@/lib/slack/classify-slack";
import { resolveSlackUserByTeam, resolveSlackUser } from "@/lib/webhooks/resolve-user";
import { writeDeadLetter } from "@/lib/webhooks/dead-letter";
import { start } from "workflow/api";
import { ingestSlackWorkflow } from "@/lib/jobs/workflows/ingest-slack";
import { createJobRecord } from "@/lib/jobs/store";
import { writeUserStore, readUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";

/**
 * Fire-and-forget timestamp update — proof-of-life for the Slack push
 * pipeline. Writes the current ISO time to `lastSlackPushAt` in the user's
 * health metadata. Throttled to once per minute per user to avoid hammering
 * the user-store on busy workspaces.
 *
 * Surfaced by the Data Freshness widget as "Push active · Xm ago" so the
 * user can tell at a glance that real-time push is healthy without the
 * widget conflating it with the cache-warm cron.
 */
const lastStamp = new Map<string, number>();
const STAMP_THROTTLE_MS = 60_000;

function stampSlackPushHeartbeat(username: string): void {
  const now = Date.now();
  const prev = lastStamp.get(username) ?? 0;
  if (now - prev < STAMP_THROTTLE_MS) return;
  lastStamp.set(username, now);

  // Fire and forget — must not block webhook response (Slack expects <3s)
  (async () => {
    try {
      const existing = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
      await writeUserStore<HealthMeta>(username, HEALTH_META_FILE, {
        ...existing,
        lastSlackPushAt: new Date(now).toISOString(),
        // A successful push proves the token is alive — clear any stale flag
        // from the hourly cron's auth.test probe.
        slackTokenInvalid: false,
      });
    } catch (err) {
      console.warn(
        "[webhooks/slack] failed to stamp push heartbeat:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}

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

  if (parsed.type === "event_callback" && parsed.event) {
    const inner = parsed.event;

    // Resolve the owning user deterministically via workspace team_id.
    // Slack includes team_id at the top-level event_callback payload.
    const teamId = parsed.team_id;
    if (!teamId) {
      await writeDeadLetter(
        "slack",
        { type: inner.type, channel: inner.channel },
        "Missing team_id in Slack event_callback payload"
      );
      return NextResponse.json({ ok: true });
    }

    let resolved = await resolveSlackUserByTeam(teamId, parsed.enterprise_id);

    // Fallback: Slack was connected via env-var tokens (SLACK_BOT_TOKEN) rather
    // than OAuth, so no teamId is stored in the persistent config. In a
    // single-user deployment this is safe — just use the first Slack-connected user.
    if (resolved === null) {
      const fallback = await resolveSlackUser();
      if (!fallback) {
        await writeDeadLetter(
          "slack",
          { type: inner.type, channel: inner.channel, team_id: teamId },
          `No user has Slack workspace ${teamId} connected`
        );
        return NextResponse.json({ ok: true });
      }
      console.warn(`[slack-webhook] teamId ${teamId} not stored; using first-match fallback user (env-var tokens). Re-connect Slack via OAuth to eliminate this warning.`);
      resolved = fallback;
    }

    if (resolved === "ambiguous") {
      await writeDeadLetter(
        "slack",
        { type: inner.type, channel: inner.channel, team_id: teamId },
        `Ambiguous owner: multiple users share Slack workspace ${teamId}`
      );
      return NextResponse.json({ ok: true });
    }
    const webhookUsername = resolved;

    try {
      const payload = slackEventToIngest(inner);
      if (payload) {
        // Dedupe: webhook may redeliver on Slack's retry policy.
        // Stamp lastSlackPushAt BEFORE the dedup early-return so retries still
        // count as proof-of-life — the integration is healthy even if this
        // exact event was already processed.
        stampSlackPushHeartbeat(webhookUsername);

        if (payload.externalId && (await hasExternalId(webhookUsername, payload.externalId))) {
          return NextResponse.json({ ok: true });
        }

        const shaped = eventFromIngest(payload);
        const event = await createEvent(webhookUsername, shaped);
        publish(event);

        // ── Slack intelligence: fire-and-forget for qualifying webhook events ──
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
          const channelName = payload.channel || payload.title || "Slack";
          const messageDate = inner.ts
            ? new Date(parseFloat(inner.ts) * 1000).toISOString()
            : new Date().toISOString();
          const slackSourceRef = payload.externalId || `slack:${channelId}:${messageTs}`;

          void createJobRecord(webhookUsername, "ingest.slack", slackSourceRef);
          await start(ingestSlackWorkflow, [
            webhookUsername,
            {
              channelId,
              messageTs,
              externalId: slackSourceRef,
              eventId: event.id,
              channelName,
              from: payload.from || "Unknown",
              date: messageDate,
              isDM: !!payload.hints?.isDM,
              isGroupDM: !!payload.hints?.isGroupDM,
              isMention: !!payload.hints?.isMention,
              bodyFallback: payload.body,
            },
          ]);
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
  /** Workspace ID — present on event_callback payloads (e.g. "T0XXXXXXXXX"). */
  team_id?: string;
  /** Enterprise Grid ID — present only on Enterprise Grid payloads (e.g. "E0XXXXXXXXX"). */
  enterprise_id?: string | null;
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
