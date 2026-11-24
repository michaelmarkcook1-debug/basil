/**
 * Explicit budget: the after() block re-classifies every unclassified event,
 * one AI call each, on THIS invocation. Reached from the cron via `fetch`, so
 * the cron's 300s does not cover it.
 */
export const maxDuration = 300;

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
import { isHashUnchanged, recordIngest } from "@/lib/ingest/index";
import { appendAuditEntries } from "@/lib/ingest/audit-log";
import { writeReprocessStatus } from "@/lib/events/reprocess-status";
import { sortOpenActions } from "@/lib/workstreams/sort-actions";

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
  // Digest meetings ("zoom-digest:…") have no Gmail message of their own; the
  // sync re-reads the digest instead.
  const zoomEvents   = toClassify.filter((ev) => ev.source === "zoom_email" && ev.externalId!.startsWith("gmail:"));
  const slackEvents  = toClassify.filter(
    (ev) => ev.source === "slack" && ev.externalId!.startsWith("slack:")
  );
  // poll-ingest stores Teams as source:"teams"; older rows were mislabelled "slack".
  const teamsEvents  = toClassify.filter(
    (ev) => (ev.source === "teams" || ev.source === "slack") && ev.externalId!.startsWith("teams:")
  );

  // Load Michael's self-identity so we can mark his messages as [You] in transcripts
  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));
  const selfDisplayName = selfIdentity.names[0] ?? undefined;

  const breakdown = [
    emailEvents.length > 0 && `${emailEvents.length} email`,
    zoomEvents.length  > 0 && `${zoomEvents.length} Zoom`,
    slackEvents.length > 0 && `${slackEvents.length} Slack`,
    teamsEvents.length > 0 && `${teamsEvents.length} Teams`,
  ].filter(Boolean).join(", ");

  // Progress, so the Settings page can show it (lib/events/reprocess-status).
  const startedMs = Date.now();
  const by = isCronCall ? "cron" as const : "button" as const;
  await writeReprocessStatus(username, {
    startedAt: new Date(startedMs).toISOString(), breakdown, total: toClassify.length,
    checked: 0, unchanged: 0, failed: 0, by,
    finishedAt: undefined, newActions: undefined, newDecisions: undefined, stoppedEarly: undefined,
  }).catch((e) => console.warn("[reprocess] status write failed:", e instanceof Error ? e.message : e));
  const before = { actions: actions.length, decisions: decisions.length };

  // ── Queue classification via after() ────────────────────────────────────
  after(async () => {
    let processed = 0;
    let checked = 0;
    let failed = 0;
    let stoppedEarly = false;
    // Stop cleanly before the platform's 300s limit kills the function mid-item:
    // what is done stays done (recordIngest), and the next press carries on.
    const outOfTime = () => Date.now() - startedMs > 270_000;
    const progress = async () => {
      checked++;
      if (checked % 10 === 0) await writeReprocessStatus(username!, { checked, unchanged: skippedUnchanged, failed }).catch(() => {}); // ci-ok: progress is best-effort; the final write reports the truth
    };
    // Counted and logged, not silent: this number IS the saving, and if it ever
    // collapses to 0 the guard has stopped working and the bill will climb again.
    let skippedUnchanged = 0;

    // ── Email (Gmail + Outlook) ────────────────────────────────────────────
    for (const ev of emailEvents) {
      if (outOfTime()) { stoppedEarly = true; break; }
      await progress();
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
        failed++;
        console.error(`[reprocess] email failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Zoom meeting summaries ─────────────────────────────────────────────
    for (const ev of zoomEvents) {
      if (outOfTime()) { stoppedEarly = true; break; }
      await progress();
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
        failed++;
        console.error(`[reprocess] zoom failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Slack ──────────────────────────────────────────────────────────────
    for (const ev of slackEvents) {
      if (outOfTime()) { stoppedEarly = true; break; }
      await progress();
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

        // Skip content we have already classified. poll-ingest has always done
        // this; reprocess computed the hash, ran the expensive classify, and
        // only THEN recorded it — so the guard it was writing was never read
        // back. Result: every Slack thread in the window was re-classified from
        // scratch every morning whether or not a single word had changed.
        // Measured 2026-07-30: classify:slack was $14.63 of a $18.53 day, all of
        // it inside the 06:00 UTC reprocess run, on a day the owner never
        // opened the app.
        const slackHash = hashContent(channelName, transcript);
        if (await isHashUnchanged(username, externalId, slackHash)) {
          skippedUnchanged++;
          continue;
        }

        // Classify the Slack intelligence
        const intel = await classifySlack({
          username,
          channelName,
          transcript,
          isDM: false,
          isMention: false,
          date: ev.createdAt,
        });

        // A FAILED classification is not "nothing here" — see poll-ingest.
        // Skipping the recordIngest below keeps it eligible for a retry.
        if (intel.classificationFailed) {
          console.warn(
            `[reprocess] slack ${externalId} classification FAILED — ` +
            `not recording hash so it retries once AI is healthy`
          );
          continue;
        }

        // Nothing actionable is still a verdict: record it (as poll-ingest does)
        // so a quiet thread is not re-classified every morning for 14 days.
        if (!shouldMaterializeSlack(intel)) {
          await recordIngest(username, { sourceRef: externalId, hash: slackHash });
          continue;
        }

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
        await recordIngest(username, {
          sourceRef: externalId,
          hash: slackHash, // same value the skip-check above read
          actionIds: slackResult.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
          decisionIds: slackResult.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
          memoryIds: slackResult.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
        });
        await appendAuditEntries(username, slackResult.auditEntries);
        processed++;
      } catch (err) {
        failed++;
        console.error(`[reprocess] slack failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Teams ──────────────────────────────────────────────────────────────
    for (const ev of teamsEvents) {
      if (outOfTime()) { stoppedEarly = true; break; }
      await progress();
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

        // Same unchanged-content guard as Slack above.
        const teamsHash = hashContent(channelName, transcript);
        if (await isHashUnchanged(username, externalId, teamsHash)) {
          skippedUnchanged++;
          continue;
        }

        const intel = await classifyTeams({
          username,
          channelName,
          transcript,
          isDM: false,
          isMention: false,
          date: ev.createdAt,
        });

        // Same rule as Slack: a failed call must not be recorded as a verdict.
        if (intel.classificationFailed) {
          console.warn(
            `[reprocess] teams ${externalId} classification FAILED — ` +
            `not recording hash so it retries once AI is healthy`
          );
          continue;
        }

        if (!shouldMaterializeTeams(intel)) {
          await recordIngest(username, { sourceRef: externalId, hash: teamsHash });
          continue;
        }

        const teamsResult = await materializeTeamsIntelligence({
          intelligence: intel,
          sourceRef: externalId,
          eventId: ev.id,
          channelName,
          from: ev.entityName || "Unknown",
          date: ev.createdAt,
          username,
        });
        await recordIngest(username, {
          sourceRef: externalId,
          hash: teamsHash, // same value the skip-check above read
          actionIds: teamsResult.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
          decisionIds: teamsResult.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
          memoryIds: teamsResult.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
        });
        await appendAuditEntries(username, teamsResult.auditEntries);
        processed++;
      } catch (err) {
        failed++;
        console.error(`[reprocess] teams failed for event ${ev.id}:`, err instanceof Error ? err.message : err);
      }
    }

    // Flush snapshot so BASIL_DATA is updated before Vercel recycles the function.
    await forceFlushSnapshot();
    // File every open commitment (new ones from this run included) into a workstream.
    if (!outOfTime()) {
      await sortOpenActions(username!, { force: true }).catch((e) =>
        console.warn("[reprocess] workstream sort failed:", e instanceof Error ? e.message : e));
    }
    const [afterActions, afterDecisions] = await Promise.all([
      listActions(username!).catch(() => null), // ci-ok: counts are a nicety; null → not reported
      listDecisions(username!).catch(() => null), // ci-ok: as above
    ]);
    await writeReprocessStatus(username!, {
      checked, unchanged: skippedUnchanged, failed,
      finishedAt: new Date().toISOString(),
      ...(afterActions ? { newActions: Math.max(0, afterActions.length - before.actions) } : {}),
      ...(afterDecisions ? { newDecisions: Math.max(0, afterDecisions.length - before.decisions) } : {}),
      ...(stoppedEarly ? { stoppedEarly: true } : {}),
    }).catch((e) => console.warn("[reprocess] status write failed:", e instanceof Error ? e.message : e));
    console.log(
      `[reprocess] completed: ${processed}/${toClassify.length} events processed` +
      `, ${skippedUnchanged} skipped as unchanged (each skip is an AI call not made)`
    );
  });

  return NextResponse.json({
    queued:  toClassify.length,
    message: `Queued ${toClassify.length} unclassified event(s) for background classification (${breakdown}).`,
  });
}

// Vercel cron jobs call GET — expose the same logic so the daily cron works.
export { POST as GET };
