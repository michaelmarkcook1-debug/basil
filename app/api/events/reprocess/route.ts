import { NextResponse, after } from "next/server";
import { listEvents } from "@/lib/events/store";
import { listActions } from "@/lib/actions/store";
import { listDecisions } from "@/lib/decisions/store";
import { processRegularEmail, processZoomEmail } from "@/lib/email/process-gmail-message";
import { getOutlookMessageBody } from "@/lib/microsoft/outlook-mail";
import { fetchSlackThread, formatThreadTranscript } from "@/lib/slack/fetch-thread";
import { classifySlack, shouldMaterializeSlack } from "@/lib/slack/classify-slack";
import { materializeSlackIntelligence } from "@/lib/slack/materialize-slack";
import { fetchTeamsThread, formatTeamsTranscript } from "@/lib/teams/fetch-thread";
import { classifyTeams, shouldMaterializeSlack as shouldMaterializeTeams } from "@/lib/teams/classify-teams";
import { materializeTeamsIntelligence } from "@/lib/teams/materialize-teams";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";
import { resolveCronUser } from "@/lib/cron/identity";
import { getSelfIdentity } from "@/lib/self-identity";
import { hashContent } from "@/lib/ingest/content-hash";
import { recordIngest } from "@/lib/ingest/index";
import { appendAuditEntries } from "@/lib/ingest/audit-log";

/**
 * POST /api/events/reprocess
 *
 * Backfill classifier: finds events from ALL sources (email, Outlook, Slack,
 * Teams) that were ingested but never materialized into the actions/decisions
 * stores, then re-runs classification using `after()` so the response returns
 * immediately.
 *
 * An event is considered "unclassified" if its externalId does not appear as
 * a sourceRef on any existing action or decision.
 *
 * Safe to run at any time — dedup is handled downstream by Jaccard similarity
 * on sourceRef, so re-running the same event never creates duplicates.
 *
 * Called from the Settings page "Re-process recent events" button.
 */

export async function POST(req: Request) {
  // Cron callers authenticate with CRON_SECRET; browser callers use session cookie.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let username: string | null = null;
  if (isCronCall) {
    username = await resolveCronUser(req);
    if (!username) return NextResponse.json({ error: "No users configured" }, { status: 503 });
  } else {
    username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  // ── Gather existing sourceRefs so we can skip already-classified events ──
  const [actions, decisions] = await Promise.all([
    listActions(username),
    listDecisions(username),
  ]);

  const classifiedRefs = new Set<string>();
  for (const a of actions) {
    if (a.sourceRef) classifiedRefs.add(a.sourceRef);
    for (const r of a.additionalSourceRefs ?? []) classifiedRefs.add(r);
  }
  for (const d of decisions) {
    if (d.sourceRef) classifiedRefs.add(d.sourceRef);
    for (const r of d.additionalSourceRefs ?? []) classifiedRefs.add(r);
  }

  // ── Find events that have never been classified ──────────────────────────
  const allEvents = await listEvents(username);

  // Only reprocess events from the last 14 days — older than that is rarely
  // actionable and keeps the AI workload manageable.
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;

  const CLASSIFIABLE_SOURCES = new Set(["email", "slack", "teams", "zoom_email"]);

  const toClassify = allEvents.filter((ev) => {
    if (!CLASSIFIABLE_SOURCES.has(ev.source)) return false;
    if (!ev.externalId) return false;
    const age = new Date(ev.createdAt).getTime();
    if (age < cutoff) return false;
    // Skip if already produced at least one action/decision
    return !classifiedRefs.has(ev.externalId);
  });

  if (toClassify.length === 0) {
    return NextResponse.json({
      queued: 0,
      message: "All recent events from email, Zoom, Slack, and Teams are already classified.",
    });
  }

  // ── Separate by source type ──────────────────────────────────────────────
  const emailEvents = toClassify.filter(
    (ev) => ev.source === "email" &&
    (ev.externalId!.startsWith("gmail:") || ev.externalId!.startsWith("outlook:"))
  );
  const zoomEvents   = toClassify.filter((ev) => ev.source === "zoom_email");
  const slackEvents  = toClassify.filter(
    (ev) => ev.source === "slack" && ev.externalId!.startsWith("slack:")
  );
  const teamsEvents  = toClassify.filter(
    (ev) => ev.source === "slack" && ev.externalId!.startsWith("teams:")
  );

  // Load Michael's self-identity so we can mark his messages as [You] in transcripts
  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));
  const selfDisplayName = selfIdentity.names[0] ?? undefined;

  // ── Queue classification via after() ────────────────────────────────────
  after(async () => {
    let processed = 0;

    // ── Email (Gmail + Outlook) ────────────────────────────────────────────
    for (const ev of emailEvents) {
      try {
        const externalId = ev.externalId!;
        const isOutlook  = externalId.startsWith("outlook:");
        const msgId      = isOutlook
          ? externalId.replace("outlook:", "")
          : externalId.replace("gmail:", "");

        await processRegularEmail({
          username,
          gmailId:         msgId,
          externalId,
          eventId:         ev.id,
          subject:         (ev.payload as { title?: string })?.title || ev.headline || "",
          from:            ev.entityName || "",
          dateFallback:    ev.createdAt,
          snippetFallback: (ev.payload as { body?: string })?.body || ev.context?.slice(0, 200) || "",
          bodyFetcher:     isOutlook ? () => getOutlookMessageBody(username, msgId) : undefined,
        });
        processed++;
      } catch (err) {
        console.error(`[reprocess] email failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Zoom meeting summaries ─────────────────────────────────────────────
    for (const ev of zoomEvents) {
      try {
        const externalId = ev.externalId!;
        // Zoom emails always use Gmail as the transport layer
        const gmailId = externalId.replace("gmail:", "");
        await processZoomEmail({
          username,
          gmailId,
          externalId,
          eventId:     ev.id,
          subject:     (ev.payload as { title?: string })?.title || ev.headline || "",
          dateFallback: ev.createdAt,
        });
        processed++;
      } catch (err) {
        console.error(`[reprocess] zoom failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Slack ──────────────────────────────────────────────────────────────
    for (const ev of slackEvents) {
      try {
        const externalId = ev.externalId!;
        // externalId format: "slack:<channelId>:<messageTs>"
        const parts      = externalId.replace("slack:", "").split(":");
        const channelId  = parts[0] ?? "";
        const messageTs  = parts[1] ?? "";
        const channelName = (ev.payload as { channel?: string })?.channel ||
          ev.entityName || "Unknown";

        const threadMessages = await fetchSlackThread(username, channelId, messageTs);
        const transcript =
          threadMessages.length > 0
            ? formatThreadTranscript(threadMessages, channelName, selfDisplayName)
            : `Channel: ${channelName}\n\n${ev.entityName || "Unknown"}: ${
                (ev.payload as { body?: string })?.body || ev.context || ""
              }`;

        // Classify the Slack intelligence
        const intel = await classifySlack({
          username,
          channelName,
          transcript,
          isDM: false,
          isMention: false,
          date: ev.createdAt,
        });

        if (!shouldMaterializeSlack(intel)) continue;

        const slackResult = await materializeSlackIntelligence({
          intelligence: intel,
          sourceRef: externalId,
          eventId: ev.id,
          channelName,
          from: ev.entityName || "Unknown",
          date: ev.createdAt,
          username,
          isDM: channelName.startsWith("DM:"),
        });
        void recordIngest(username, {
          sourceRef: externalId,
          hash: hashContent(channelName, transcript),
          actionIds: slackResult.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
          decisionIds: slackResult.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
          memoryIds: slackResult.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
        });
        void appendAuditEntries(username, slackResult.auditEntries);
        processed++;
      } catch (err) {
        console.error(`[reprocess] slack failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Teams ──────────────────────────────────────────────────────────────
    for (const ev of teamsEvents) {
      try {
        const externalId = ev.externalId!;
        // externalId format: "teams:<chatOrChannelId>:<messageId>" or similar
        const withoutPrefix = externalId.replace("teams:", "");
        const lastColon     = withoutPrefix.lastIndexOf(":");
        const chatOrChannelId = lastColon > 0
          ? withoutPrefix.slice(0, lastColon)
          : withoutPrefix;
        const messageId    = lastColon > 0 ? withoutPrefix.slice(lastColon + 1) : "";
        const channelName  = (ev.payload as { channel?: string })?.channel ||
          ev.entityName || "Unknown";

        const threadMessages = await fetchTeamsThread(
          username, chatOrChannelId, null, messageId
        );
        const transcript =
          threadMessages.length > 0
            ? formatTeamsTranscript(threadMessages, channelName)
            : `Channel: ${channelName}\n\n${ev.entityName || "Unknown"}: ${
                (ev.payload as { body?: string })?.body || ev.context || ""
              }`;

        const intel = await classifyTeams({
          username,
          channelName,
          transcript,
          isDM: false,
          isMention: false,
          date: ev.createdAt,
        });

        if (!shouldMaterializeTeams(intel)) continue;

        const teamsResult = await materializeTeamsIntelligence({
          intelligence: intel,
          sourceRef: externalId,
          eventId: ev.id,
          channelName,
          from: ev.entityName || "Unknown",
          date: ev.createdAt,
          username,
        });
        void recordIngest(username, {
          sourceRef: externalId,
          hash: hashContent(channelName, transcript),
          actionIds: teamsResult.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
          decisionIds: teamsResult.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
          memoryIds: teamsResult.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
        });
        void appendAuditEntries(username, teamsResult.auditEntries);
        processed++;
      } catch (err) {
        console.error(`[reprocess] teams failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // Flush snapshot so BASIL_DATA is updated before Vercel recycles the function.
    await forceFlushSnapshot();
    console.log(`[reprocess] completed: ${processed}/${toClassify.length} events processed`);
  });

  const breakdown = [
    emailEvents.length > 0 && `${emailEvents.length} email`,
    zoomEvents.length  > 0 && `${zoomEvents.length} Zoom`,
    slackEvents.length > 0 && `${slackEvents.length} Slack`,
    teamsEvents.length > 0 && `${teamsEvents.length} Teams`,
  ].filter(Boolean).join(", ");

  return NextResponse.json({
    queued:  toClassify.length,
    message: `Queued ${toClassify.length} unclassified event(s) for background classification (${breakdown}).`,
  });
}

// Vercel cron jobs call GET — expose the same logic so the daily cron works.
export { POST as GET };
