import { NextResponse, after } from "next/server";
import { createEvent, hasExternalId, updateEvent, compactEvents } from "@/lib/events/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { writeUserStore, readUserStore } from "@/lib/storage/user-store";
import { HEALTH_META_FILE, type HealthMeta } from "@/lib/system/health";
import { eventFromIngest } from "@/lib/events/rules";
import { publish } from "@/lib/events/bus";
import { generateDraftForEvent } from "@/lib/events/drafter";
import type { IngestPayload, BasilEvent } from "@/lib/events/types";
import { getTodayEvents } from "@/lib/google/calendar";
import { getRecentEmails, searchEmails, checkThreadForSentReply } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { listActions, updateAction, createAction } from "@/lib/actions/store";
import { createDecision, listDecisions } from "@/lib/decisions/store";
import { getMyOpenIssues, linearPriorityToBasil } from "@/lib/linear/client";
import { isZoomConnected } from "@/lib/zoom/auth";
import { getPastMeetings, getMeetingParticipants, getRecentRecordingsWithTranscripts } from "@/lib/zoom/client";
import { processZoomMeeting } from "@/lib/zoom/process-meeting";
import { getSelfIdentity, isSelf } from "@/lib/self-identity";
import { ZOOM_GMAIL_QUERY, detectZoomEmail } from "@/lib/google/zoom-email-detector";
import { processRegularEmail, processZoomEmail } from "@/lib/email/process-gmail-message";
import { getSessionUser } from "@/lib/auth";
import { getUsers, isAdminUser } from "@/lib/users";
import { fetchSlackThread, formatThreadTranscript } from "@/lib/slack/fetch-thread";
import { classifySlack, shouldClassifySlack, shouldMaterializeSlack } from "@/lib/slack/classify-slack";
import { materializeSlackIntelligence } from "@/lib/slack/materialize-slack";
// Microsoft 365 sources (only used when Microsoft tokens are present)
import { getRecentOutlookMessages, getOutlookMessageBody } from "@/lib/microsoft/outlook-mail";
import { getRecentTeamsMessages } from "@/lib/teams/client";
import { fetchTeamsThread, formatTeamsTranscript } from "@/lib/teams/fetch-thread";
import { classifyTeams, shouldMaterializeSlack as shouldMaterializeTeams } from "@/lib/teams/classify-teams";
import { materializeTeamsIntelligence } from "@/lib/teams/materialize-teams";
import { hashContent } from "@/lib/ingest/content-hash";
import { isHashUnchanged, recordIngest } from "@/lib/ingest/index";
import { appendAuditEntries, auditSkipped } from "@/lib/ingest/audit-log";
import { listUserContacts, updateUserContactInStore } from "@/lib/contacts/user-store";
import { contacts as seedContacts } from "@/lib/contacts-data";

/**
 * POST /api/events/poll-ingest
 *
 * Pulls recent signal from the working integrations (Gmail, Slack, Calendar)
 * and runs each item through the rules engine to create Basil events. Dedupes
 * against previously-seen externalIds so repeated polling is idempotent.
 *
 * Zoom meeting summary emails receive dedicated treatment:
 *  1. Pre-filtered via Gmail query (server-side, efficient).
 *  2. Full body fetched for structured extraction.
 *  3. Action items → Actions store, decisions → Decisions store,
 *     meeting summary → Memory store.
 *  4. Excluded from the regular email loop so the same message is never
 *     double-ingested as both source:"email" and source:"zoom_email".
 *
 * This exists because real webhook subscriptions (Gmail Pub/Sub, Slack Events
 * API, Calendar events.watch) aren't registered yet. Polling bridges the gap
 * so "Basil is watching" actually has something to watch.
 */


export async function POST(req: Request) {
  // Cron and server-to-server callers authenticate with CRON_SECRET.
  // Browser callers (manual trigger from settings page) use the session cookie.
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = cronSecret && authHeader === `Bearer ${cronSecret}`;

  let username: string | null = null;
  if (isCronCall) {
    // The cron wrapper /api/cron/poll-ingest fans out by sending one POST per
    // user with an X-Basil-Username header.  When that header is present, use
    // it directly; otherwise fall back to the first admin/first user so a
    // direct cron invocation without the wrapper still works.
    const cronUsername = req.headers.get("x-basil-username");
    if (cronUsername) {
      username = cronUsername;
    } else {
      const users = await getUsers();
      const adminUser = users.find((u) => isAdminUser(u.username)) ?? users[0];
      username = adminUser?.username ?? null;
    }
    if (!username) {
      return NextResponse.json({ error: "No users configured" }, { status: 503 });
    }
  } else {
    username = await getSessionUser();
    if (!username) {
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
  }

  // ── Contact name sets (dynamic key-person classification) ────────────────────
  // Every contact is treated as a key person for Slack classification.
  // Investor-tagged contacts (Sam Rivera, Jordan Avery) get extra priority escalation.
  //
  // We load user-added contacts and merge with seed contacts so new contacts
  // added via the UI are immediately picked up on the next poll.
  const [userContacts] = await Promise.all([
    listUserContacts(username).catch(() => []),
  ]);
  const allContacts = [...seedContacts, ...userContacts];

  /** Lowercase name tokens for every contact — first name and full name. */
  const contactNameSet = new Set<string>();
  /** Lowercase name tokens for investor-tagged contacts only. */
  const investorNameSet = new Set<string>();

  for (const c of allContacts) {
    const full = c.name.trim().toLowerCase();
    const first = full.split(" ")[0];
    if (full) contactNameSet.add(full);
    if (first && first.length > 2) contactNameSet.add(first);

    if (c.tags.includes("investor")) {
      if (full) investorNameSet.add(full);
      if (first && first.length > 2) investorNameSet.add(first);
    }
  }

  /** Returns true if `text` contains the name of any contact. */
  const isKnownContact = (text: string): boolean => {
    const t = text.toLowerCase();
    for (const name of contactNameSet) {
      if (t.includes(name)) return true;
    }
    return false;
  };

  /** Returns true if `text` contains the name of an investor contact. */
  const isInvestorContact = (text: string): boolean => {
    const t = text.toLowerCase();
    for (const name of investorNameSet) {
      if (t.includes(name)) return true;
    }
    return false;
  };

  /**
   * Updates `lastInteraction` on a user-added contact that matches the given
   * display name. Non-fatal — failures are swallowed silently.
   * Only updates if the new date is newer than the stored value.
   */
  const touchContactLastInteraction = async (displayName: string, isoDate: string): Promise<void> => {
    if (!displayName?.trim()) return;
    const nameLower = displayName.toLowerCase();
    // Find the best matching user-added contact (seed contacts are read-only)
    const match = userContacts.find((c) => {
      const full = c.name.trim().toLowerCase();
      const first = full.split(" ")[0];
      return nameLower.includes(full) || full.includes(nameLower) || (first && first.length > 2 && nameLower.includes(first));
    });
    if (!match) return;
    // Only update if newer (string comparison is fine for ISO dates)
    if (match.lastInteraction && match.lastInteraction >= isoDate) return;
    await updateUserContactInStore(username, match.id, {
      lastInteraction: isoDate,
      activitySource: "slack",
    }).catch(() => {/* non-fatal */});
  };

  // ── Parallel source fetch ────────────────────────────────────────────────────
  // Zoom emails are fetched separately so they can be excluded from the regular
  // email loop and processed with full-body extraction.
  // Microsoft sources (Outlook + Teams) are fetched concurrently — they return
  // empty arrays silently when Microsoft is not connected, so they never block.
  const [emails, slacks, calEvents, zoomEmails, outlookEmails, teamsMessages, selfIdentity] = await Promise.all([
    getRecentEmails(username, 20).catch(() => []),
    getRecentSlackMessages(username, 30).catch(() => []),
    getTodayEvents(username).catch(() => []),
    searchEmails(username, ZOOM_GMAIL_QUERY, 25).catch(() => []),
    getRecentOutlookMessages(username, 20, 2).catch(() => []),
    getRecentTeamsMessages(username, 30, 3).catch(() => []),
    getSelfIdentity(username),
  ]);

  // Build a Set of Gmail message IDs confirmed as Zoom emails so the regular
  // email loop can skip them (avoids double-ingestion with different source types).
  const zoomEmailIds = new Set(zoomEmails.map((m) => m.id));

  const payloads: IngestPayload[] = [];

  // ── Regular emails (excluding Zoom and self-sent) ───────────────────────────
  for (const e of emails) {
    // Skip Zoom emails — they have a dedicated processing path below
    if (zoomEmailIds.has(e.id)) continue;

    // Skip emails sent BY the user — Basil watches incoming signal only.
    // Without this, emails Michael sends (e.g. about contracts, legal topics)
    // get ingested and incorrectly flagged as high-priority heads-ups.
    if (isSelf(e.from, selfIdentity)) continue;

    // Secondary detection: catch Zoom emails that slipped past the query
    // (e.g. if the from field still contains "zoom" in the display name)
    const signal = detectZoomEmail({ from: e.from, subject: e.subject, snippet: e.snippet });
    if (signal.isZoom && signal.confidence >= 0.8) {
      zoomEmailIds.add(e.id);
      continue;
    }

    payloads.push({
      source: "email",
      externalId: `gmail:${e.id}`,
      title: e.subject || "(no subject)",
      body: e.snippet || "",
      from: e.from,
      fromEmail: e.fromEmail,
      // Preserve the email's actual send time — used in memory labels and decision dates.
      // Defaults to ingest time in classify/materialize if absent.
      date: e.date,
      hints: { isDM: false },
    });
  }

  // ── Slack (skip self-authored and bot DMs) ────────────────────────────────
  const BOT_CHANNEL_NAMES = [
    "google calendar", "slackbot", "notion", "linear",
    "github", "loom", "zoom", "claude", "reclaim", "asana",
  ];
  const isBotChannel = (channel: string) => {
    const c = channel.toLowerCase();
    return BOT_CHANNEL_NAMES.some((n) => c.includes(`dm: ${n}`));
  };

  // Metadata map: externalId → { channelId, messageTs, channelName }
  // Built alongside payloads so we don't have to re-parse externalId strings later.
  const slackMetaMap = new Map<string, {
    channelId: string;
    messageTs: string;
    channelName: string;
  }>();

  for (const m of slacks) {
    if (isSelf(m.author, selfIdentity)) continue;
    if (isBotChannel(m.channel)) continue;
    const isDM = m.channel.startsWith("DM:");
    const isGroupDM = m.channel.startsWith("Group DM");
    const externalId = `slack:${m.channelId || m.channel}:${m.id}`;
    payloads.push({
      source: "slack",
      externalId,
      title: `${m.channel} — ${m.author}`,
      body: m.text,
      from: m.author,
      channel: m.channel,
      // m.date is already ISO (see lib/slack/client.ts line ~201)
      date: m.date,
      hints: {
        isDM,
        isGroupDM,
        isMention: m.isMention,
        // Every contact is a key person — drives shouldClassifySlack gate
        isFromKeyPerson: isKnownContact(m.author),
        // Investor contacts (Sam Rivera, Jordan Avery) get high-priority escalation
        isFromInvestor: isInvestorContact(m.author),
      },
    });
    // Only track if we have a real channelId — needed for thread fetching
    if (m.channelId) {
      slackMetaMap.set(externalId, {
        channelId: m.channelId,
        messageTs: m.id,
        channelName: m.channel,
      });
    }
  }

  // ── Outlook emails (Microsoft 365) ──────────────────────────────────────
  for (const e of outlookEmails) {
    payloads.push({
      source: "email",
      externalId: `outlook:${e.id}`,
      title: e.subject || "(no subject)",
      body: e.snippet || "",
      from: e.from,
      date: e.date,
      hints: { isDM: false },
    });
  }

  // ── Teams messages (Microsoft 365) ──────────────────────────────────────
  // Metadata map for Teams thread fetching (mirrors the Slack slackMetaMap)
  const teamsMetaMap = new Map<string, {
    chatOrChannelId: string;
    channelId: string | null;
    messageId: string;
    channelName: string;
  }>();

  for (const m of teamsMessages) {
    if (isSelf(m.author, selfIdentity)) continue;
    const externalId = `teams:${m.chatOrChannelId}:${m.id}`;
    payloads.push({
      source: "slack", // ActionItem.source has no "teams" — use "slack" as closest
      externalId,
      title: `${m.channel} — ${m.author}`,
      body: m.text,
      from: m.author,
      channel: m.channel,
      date: m.date,
      hints: { isDM: m.isDM, isGroupDM: false, isMention: m.isMention },
    });
    teamsMetaMap.set(externalId, {
      chatOrChannelId: m.chatOrChannelId,
      channelId: m.channelId ?? null,
      messageId: m.id,
      channelName: m.channel,
    });
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  for (const c of calEvents) {
    payloads.push({
      source: "calendar",
      externalId: `calendar:${c.id}`,
      title: c.summary,
      body: `${c.dateLabel || "Today"} — ${c.attendees.join(", ") || "no attendees listed"}`,
      from: c.attendees[0],
    });
  }

  // ── Zoom email payloads ───────────────────────────────────────────────────
  // These get source: "zoom_email" and are always auto-classified.
  const zoomPayloads: IngestPayload[] = zoomEmails.map((e) => ({
    source: "zoom_email" as const,
    externalId: `gmail:${e.id}`,
    title: e.subject || "Zoom Meeting Summary",
    body: e.snippet || "",
    from: e.from,
    // Preserve email date so extractZoomMeeting fallback date is the send time, not ingest time
    date: e.date,
  }));

  // ── Dedupe + persist: regular payloads ───────────────────────────────────
  let ingested = 0;
  const draftEvents: BasilEvent[] = [];

  // Collect (payload, event) pairs for post-processing intelligence pipelines.
  // Both run fire-and-forget after events are persisted so the response is fast.
  const emailsToClassify: Array<{ payload: IngestPayload; eventId: string }> = [];
  const slacksToClassify: Array<{
    payload: IngestPayload;
    eventId: string;
    channelId: string;
    messageTs: string;
    channelName: string;
    tags: string[];
  }> = [];
  const teamsToClassify: Array<{
    payload: IngestPayload;
    eventId: string;
    chatOrChannelId: string;
    channelId: string | null;
    messageId: string;
    channelName: string;
    tags: string[];
  }> = [];

  for (const p of payloads) {
    if (p.externalId && (await hasExternalId(username, p.externalId))) continue;
    const shaped = eventFromIngest(p);
    const event = await createEvent(username, shaped);
    publish(event);
    ingested++;
    if (event.disposition === "draft" && event.draft) {
      draftEvents.push(event);
    }
    // Queue email-sourced events for intelligence classification
    if (p.source === "email" && p.externalId) {
      emailsToClassify.push({ payload: p, eventId: event.id });
    }
    // Queue qualifying Slack events for thread-aware intelligence classification
    if (p.source === "slack" && p.externalId) {
      const slackMeta = slackMetaMap.get(p.externalId);
      const teamsMeta = teamsMetaMap.get(p.externalId);

      if (slackMeta && shouldClassifySlack({
        isDM: !!p.hints?.isDM,
        isGroupDM: !!p.hints?.isGroupDM,
        isMention: !!p.hints?.isMention,
        // Use the dynamic contact-set check — every contact is a key person
        isFromKeyPerson: !!p.hints?.isFromKeyPerson || isKnownContact(p.from || ""),
        tags: event.tags,
      })) {
        slacksToClassify.push({
          payload: p,
          eventId: event.id,
          channelId: slackMeta.channelId,
          messageTs: slackMeta.messageTs,
          channelName: slackMeta.channelName,
          tags: event.tags,
        });
      }

      // Teams messages (also stored with source:"slack") share the classify gate
      if (teamsMeta && shouldClassifySlack({
        isDM: !!p.hints?.isDM,
        isGroupDM: false,
        isMention: !!p.hints?.isMention,
        // Use the dynamic contact-set check — every contact is a key person
        isFromKeyPerson: !!p.hints?.isFromKeyPerson || isKnownContact(p.from || ""),
        tags: event.tags,
      })) {
        teamsToClassify.push({
          payload: p,
          eventId: event.id,
          chatOrChannelId: teamsMeta.chatOrChannelId,
          channelId: teamsMeta.channelId,
          messageId: teamsMeta.messageId,
          channelName: teamsMeta.channelName,
          tags: event.tags,
        });
      }
    }
  }

  // ── Email intelligence: classify + materialize (after-response) ─────────
  // For each newly-ingested non-Zoom email, run AI classification and write
  // actions/decisions/memory based on what was found.
  //
  // Uses next/server `after()` so Vercel keeps the function instance alive
  // until all background work completes — `void` fire-and-forget is not
  // guaranteed to finish before the instance is recycled on Fluid Compute.
  //
  // Outlook emails (externalId starts with "outlook:") are fetched via the
  // Microsoft Graph API instead of the Gmail API, so the full body is
  // available for accurate classification rather than just the 200-char snippet.
  if (emailsToClassify.length > 0) {
    after(async () => {
      for (const { payload, eventId } of emailsToClassify) {
        const externalId = payload.externalId!;
        const isOutlook = externalId.startsWith("outlook:");
        const msgId = isOutlook
          ? externalId.replace("outlook:", "")
          : externalId.replace("gmail:", "");
        await processRegularEmail({
          username,
          gmailId: msgId,
          externalId,
          eventId,
          subject: payload.title || "",
          from: payload.from || "",
          dateFallback: payload.date,
          snippetFallback: payload.body,
          bodyFetcher: isOutlook
            ? () => getOutlookMessageBody(username, msgId)
            : undefined,
        });
        // Update contact lastInteraction after email processing
        if (payload.from && payload.date) {
          await touchContactLastInteraction(payload.from, payload.date).catch(() => { /* basil-ci-allow-silent-catch: contact recency update is non-fatal */ });
        }
      }
      // Flush snapshot after all mutations so BASIL_DATA is updated before
      // Vercel recycles this function instance.
      await forceFlushSnapshot();
    });
  }

  // ── Slack intelligence: fetch thread + classify + materialize (after-response) ──
  // For each qualifying Slack message: fetch the full thread for context, run
  // AI classification, then materialize actions/decisions/memory.
  if (slacksToClassify.length > 0) {
    after(async () => {
      for (const { payload, eventId, channelId, messageTs, channelName } of slacksToClassify) {
        try {
          // Fetch full thread — gives the AI conversation context, not just a snippet
          const threadMessages = await fetchSlackThread(username, channelId, messageTs);

          // Pass Michael's display name so [You] markers are injected for his messages.
          const selfDisplayName = selfIdentity.names[0] ?? undefined;

          // If no thread replies fetched, fall back to the snippet we already have
          const transcript =
            threadMessages.length > 0
              ? formatThreadTranscript(threadMessages, channelName, selfDisplayName)
              : `Channel: ${channelName}\n\n${payload.from || "Unknown"}: ${payload.body || ""}`;

          const slackSourceRef = payload.externalId!;
          const slackContentHash = hashContent(channelName, transcript);
          const slackUnchanged = await isHashUnchanged(username, slackSourceRef, slackContentHash);
          if (slackUnchanged) {
            console.log(`[poll-ingest] slack ${slackSourceRef} unchanged — skipping`);
            void appendAuditEntries(username, [
              auditSkipped(slackSourceRef, "action", `Slack content unchanged for ${slackSourceRef}`),
            ]);
            continue;
          }

          const intel = await classifySlack({
            username,
            channelName,
            transcript,
            isDM: !!payload.hints?.isDM,
            isMention: !!payload.hints?.isMention,
            // Use the Slack message's actual timestamp; fall back to ingest time if absent
            date: payload.date || new Date().toISOString(),
          });

          if (!shouldMaterializeSlack(intel)) {
            void recordIngest(username, { sourceRef: slackSourceRef, hash: slackContentHash });
            continue;
          }

          const result = await materializeSlackIntelligence({
            intelligence: intel,
            sourceRef: slackSourceRef,
            eventId,
            channelName,
            from: payload.from || "Unknown",
            // Use the Slack message's actual send date, not ingest time
            date: payload.date || new Date().toISOString(),
            username,
            isDM: !!payload.hints?.isDM,
          });

          const slackActionIds = result.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!);
          const slackDecisionIds = result.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!);
          const slackMemoryIds = result.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!);
          void recordIngest(username, {
            sourceRef: slackSourceRef,
            hash: slackContentHash,
            actionIds: slackActionIds,
            decisionIds: slackDecisionIds,
            memoryIds: slackMemoryIds,
          });
          void appendAuditEntries(username, result.auditEntries);

          // ── SignalEvent write (mirrors ingestSlackWorkflow) ─────────────────
          // poll-ingest is the primary data path (cron every 15 min). Without
          // this, signals only populate via webhook push (which may not be
          // registered). The normalizer + enrichAndWriteSignal are idempotent.
          try {
            const { getFlags: getPollFlags } = await import("@/core/feature-flags");
            const pollFlags = await getPollFlags(username);
            if (pollFlags.signalEvent_active) {
              const { normalizeSlackSignal } = await import("@/core/signals/normalizers/slack.normalizer");
              const { enrichAndWriteSignal } = await import("@/core/ingestion/signal-pipeline");
              const normPayload = {
                channelId,
                messageTs,
                externalId: slackSourceRef,
                eventId,
                channelName,
                from: payload.from || "Unknown",
                date: payload.date || new Date().toISOString(),
                isDM: !!payload.hints?.isDM,
                isGroupDM: !!payload.hints?.isGroupDM,
                isMention: !!payload.hints?.isMention,
                bodyFallback: payload.body,
              };
              const signal = normalizeSlackSignal({
                payload: normPayload,
                transcript,
                senderIsKnown: !!payload.hints?.isFromKeyPerson,
              });
              signal.actionIds  = slackActionIds;
              signal.decisionIds = slackDecisionIds;
              signal.memoryIds  = slackMemoryIds;
              signal.category   = (intel.category as typeof signal.category) ?? "unknown";
              signal.actions    = (intel.actions ?? []).map((a) => ({
                text: a.text, dueDate: a.dueDate, priority: a.priority,
              }));
              signal.decisions  = (intel.decisions ?? []).map((d) => ({
                text: d.text, title: d.title, decidedBy: d.decidedBy,
                rationale: d.rationale, alternatives: d.alternatives, consequences: d.consequences,
              }));
              await enrichAndWriteSignal(username, signal, pollFlags);
            }
          } catch (signalErr) {
            console.error(`[poll-ingest] slack signalEvent write failed for ${slackSourceRef}:`,
              signalErr instanceof Error ? signalErr.message : signalErr);
          }

          // Write back-links on the originating BasilEvent so the Events feed
          // can show how many items were spawned from this Slack message.
          if (slackActionIds.length > 0 || slackDecisionIds.length > 0 || slackMemoryIds.length > 0) {
            const slackBackLink: Record<string, string> = {};
            if (slackActionIds[0]) slackBackLink.actionId = slackActionIds[0];
            if (slackDecisionIds[0]) slackBackLink.decisionId = slackDecisionIds[0];
            if (slackMemoryIds[0]) slackBackLink.memoryId = slackMemoryIds[0];
            void updateEvent(username, eventId, slackBackLink).catch(() => {/* non-fatal */});
          }

          // Update contact lastInteraction so the Contacts tab stays current
          if (payload.from && payload.date) {
            await touchContactLastInteraction(payload.from, payload.date).catch(() => { /* basil-ci-allow-silent-catch: contact recency update is non-fatal */ });
          }

        } catch (err) {
          console.error(
            `[poll-ingest] slack intelligence failed for ${payload.externalId}:`,
            err
          );
        }
      }
      await forceFlushSnapshot();
    });
  }

  // ── Teams intelligence: fetch thread + classify + materialize (after-response) ──
  if (teamsToClassify.length > 0) {
    after(async () => {
      for (const { payload, eventId, chatOrChannelId, channelId, messageId, channelName } of teamsToClassify) {
        try {
          const threadMessages = await fetchTeamsThread(username, chatOrChannelId, channelId, messageId);
          const transcript =
            threadMessages.length > 0
              ? formatTeamsTranscript(threadMessages, channelName)
              : `Channel: ${channelName}\n\n${payload.from || "Unknown"}: ${payload.body || ""}`;

          const teamsSourceRef = payload.externalId!;
          const teamsContentHash = hashContent(channelName, transcript);
          const teamsUnchanged = await isHashUnchanged(username, teamsSourceRef, teamsContentHash);
          if (teamsUnchanged) {
            console.log(`[poll-ingest] teams ${teamsSourceRef} unchanged — skipping`);
            void appendAuditEntries(username, [
              auditSkipped(teamsSourceRef, "action", `Teams content unchanged for ${teamsSourceRef}`),
            ]);
            continue;
          }

          const intel = await classifyTeams({
            username,
            channelName,
            transcript,
            isDM: !!payload.hints?.isDM,
            isMention: !!payload.hints?.isMention,
            date: payload.date || new Date().toISOString(),
          });

          if (!shouldMaterializeTeams(intel)) {
            void recordIngest(username, { sourceRef: teamsSourceRef, hash: teamsContentHash });
            continue;
          }

          const result = await materializeTeamsIntelligence({
            intelligence: intel,
            sourceRef: teamsSourceRef,
            eventId,
            channelName,
            from: payload.from || "Unknown",
            date: payload.date || new Date().toISOString(),
            username,
          });

          const teamsActionIds = result.auditEntries?.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!) ?? [];
          const teamsDecisionIds = result.auditEntries?.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!) ?? [];
          const teamsMemoryIds = result.auditEntries?.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!) ?? [];
          void recordIngest(username, {
            sourceRef: teamsSourceRef,
            hash: teamsContentHash,
            actionIds: teamsActionIds,
            decisionIds: teamsDecisionIds,
            memoryIds: teamsMemoryIds,
          });
          if (result.auditEntries?.length) {
            void appendAuditEntries(username, result.auditEntries);
          }

          // Back-links on the originating BasilEvent
          if (teamsActionIds.length > 0 || teamsDecisionIds.length > 0 || teamsMemoryIds.length > 0) {
            const teamsBackLink: Record<string, string> = {};
            if (teamsActionIds[0]) teamsBackLink.actionId = teamsActionIds[0];
            if (teamsDecisionIds[0]) teamsBackLink.decisionId = teamsDecisionIds[0];
            if (teamsMemoryIds[0]) teamsBackLink.memoryId = teamsMemoryIds[0];
            void updateEvent(username, eventId, teamsBackLink).catch(() => {/* non-fatal */});
          }

        } catch (err) {
          console.error(`[poll-ingest] teams intelligence failed for ${payload.externalId}:`, err);
        }
      }
      await forceFlushSnapshot();
    });
  }

  // ── Generate AI drafts in parallel ───────────────────────────────────────
  if (draftEvents.length > 0) {
    await Promise.allSettled(
      draftEvents.map(async (event) => {
        try {
          const result = await generateDraftForEvent(event, username);
          const updated = await updateEvent(username, event.id, {
            draft: {
              ...event.draft!,
              body: result.body,
              generatedAt: result.generatedAt,
              caveat: result.caveat,
            },
          });
          if (updated) {
            publish(updated);
          }
        } catch (err) {
          console.error(`[poll-ingest] draft generation failed for event ${event.id}:`, err);
        }
      })
    );
  }

  // ── Dedupe + persist: Zoom emails ────────────────────────────────────────
  // For each new Zoom email: create the event record, then run structured
  // extraction and materialize outputs into Actions / Decisions / Memory.
  // Materialization runs fire-and-forget, so actual counts are emitted to
  // server logs after this response returns — not included in the response.
  let zoomIngested = 0;

  for (const p of zoomPayloads) {
    if (p.externalId && (await hasExternalId(username, p.externalId))) continue;

    const shaped = eventFromIngest(p);
    const event = await createEvent(username, shaped);
    publish(event);
    zoomIngested++;

    // Fetch, extract, and materialize using after() — Vercel-safe background
    // completion. Delegates to the same shared helper used by the Gmail
    // push-notification webhook so both ingest paths produce identical,
    // idempotent durable records.
    const gmailId = p.externalId?.replace("gmail:", "");
    if (!gmailId) continue;

    const zoomEventId = event.id;
    const zoomExternalId = p.externalId!;
    const zoomSubject = p.title;
    const zoomDate = p.date;
    after(async () => {
      await processZoomEmail({
        username,
        gmailId,
        externalId: zoomExternalId,
        eventId: zoomEventId,
        subject: zoomSubject,
        dateFallback: zoomDate,
      });
      await forceFlushSnapshot();
    });
  }

  // Run event compaction after ingestion — keeps the events store small
  // so the BASIL_DATA snapshot stays within Vercel's env var size limit.
  // Fire-and-forget: compaction never fails the poll-ingest response.
  const eventsCompacted = await compactEvents(username).catch((err) => {
    console.error("[poll-ingest] event compaction failed:", err);
    return 0;
  });

  // ── Email action completion detection ─────────────────────────────────────
  // For each open email action with a Gmail sourceRef, check whether the user
  // has sent a reply in that thread since the action was created. If yes:
  //   1. Mark the action "done"
  //   2. Create a Decision recording what was resolved, with suggested follow-ups
  //
  // Capped at 10 per cycle to avoid excessive Gmail API usage.
  let actionsAutoCompleted = 0;
  after(async () => {
    try {
      const allActions = await listActions(username);
      const emailActions = allActions
        .filter((a) => a.status === "open" && a.source === "email" && a.sourceRef?.startsWith("gmail:"))
        .slice(0, 10);

      for (const action of emailActions) {
        const originalMessageId = action.sourceRef!.replace("gmail:", "");
        const reply = await checkThreadForSentReply(username, originalMessageId, action.createdAt);
        if (!reply) continue;

        // Mark action done
        await updateAction(username, action.id, {
          status:         "done",
          lastActivityAt: reply.sentAt,
        });

        // Follow-up date: 3 business days from now
        const followUpDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
          .toISOString().split("T")[0];

        // Create a Decision capturing the completed action and suggested next steps
        await createDecision(username, {
          title:   `Replied to ${reply.originalFrom} re: ${reply.subject.slice(0, 50)}`,
          text:    `Sent reply to ${reply.originalFrom} regarding "${reply.subject}". Original action: ${action.text}`,
          summary: `Replied to ${reply.originalFrom} completing the pending action: "${action.text}"`,
          consequences: [
            `Await response from ${reply.originalFrom}`,
            `Follow up if no reply by ${followUpDate}`,
          ],
          decidedBy:      username,
          context:        reply.subject,
          source:         "email",
          sourceRef:      `gmail:${reply.messageId}`,
          linkedActionIds: [action.id],
          confidence:     0.9,
          date:           reply.sentAt.split("T")[0],
        });

        actionsAutoCompleted++;
        console.log(`[poll-ingest] Auto-completed action ${action.id} — reply found in thread`);
      }

      if (actionsAutoCompleted > 0) await forceFlushSnapshot();
    } catch (err) {
      console.error("[poll-ingest] Email action completion check failed:", err);
    }
  });

  // ── Linear issue sync ─────────────────────────────────────────────────────
  // Pull open issues assigned to the user from Linear and upsert them as
  // ActionItems with source:"linear". The existing Jaccard dedup in createAction
  // makes this fully idempotent — already-imported issues are skipped.
  after(async () => {
    try {
      const linearIssues = await getMyOpenIssues(username);
      if (linearIssues.length === 0) return;

      let synced = 0;
      for (const issue of linearIssues) {
        const sourceRef = `linear:${issue.identifier}`;
        const projectLabel = issue.project?.name ? ` [${issue.project.name}]` : "";
        await createAction(username, {
          text:      `${issue.identifier}: ${issue.title}${projectLabel}`,
          source:    "linear",
          sourceRef,
          priority:  linearPriorityToBasil(issue.priority),
          dueDate:   issue.dueDate ?? undefined,
          confidence: 1,
          needsReview: false,
          status:    "open",
        });
        synced++;
      }
      if (synced > 0) {
        console.log(`[poll-ingest] Linear: synced ${synced} issue(s)`);
        await forceFlushSnapshot();
      }

      // Close any Basil action whose Linear issue is no longer "my open" —
      // covers completed, cancelled, and reassign-away cases. force:true
      // because cron runs are deliberate sweeps.
      try {
        const { syncLinearActionStates } = await import("@/lib/linear/sync-actions");
        const result = await syncLinearActionStates(username, { force: true });
        if (result.closed > 0) {
          console.log(
            `[poll-ingest] Linear: auto-closed ${result.closed} stale action(s)`
          );
          await forceFlushSnapshot();
        }
      } catch (err) {
        console.warn("[poll-ingest] Linear action-state sync failed:", err);
      }
    } catch (err) {
      console.error("[poll-ingest] Linear sync failed:", err);
    }
  });

  // ── Zoom direct API meeting sync ─────────────────────────────────────────
  after(async () => {
    try {
      const zoomConnected = await isZoomConnected(username);
      if (!zoomConnected) return;

      // Fetch meetings from last 3 days (short window; polls run frequently)
      const pastMeetings = await getPastMeetings(username, 3, 20);
      if (pastMeetings.length === 0) return;

      // Build set of already-processed zoom-api sourceRefs
      const [allActions, allDecisions] = await Promise.all([
        listActions(username),
        listDecisions(username),
      ]);
      const processedRefs = new Set<string>();
      for (const a of allActions) {
        if (a.sourceRef?.startsWith("zoom-api:")) processedRefs.add(a.sourceRef);
      }
      for (const d of allDecisions) {
        if (d.sourceRef?.startsWith("zoom-api:")) processedRefs.add(d.sourceRef);
      }

      // Fetch recordings with transcripts (best-effort; may be empty)
      const recordings = await getRecentRecordingsWithTranscripts(username, 3, 10);
      const recordingMap = new Map(recordings.map((r) => [r.meetingId, r]));

      let processed = 0;
      for (const meeting of pastMeetings) {
        const sourceRef = `zoom-api:${meeting.id}`;
        if (processedRefs.has(sourceRef)) continue;

        const [participants, recording] = await Promise.all([
          getMeetingParticipants(username, meeting.uuid),
          Promise.resolve(recordingMap.get(meeting.id)),
        ]);

        await processZoomMeeting({ username, meeting, participants, recording });
        processed++;
      }

      if (processed > 0) {
        console.log(`[poll-ingest] Zoom API: processed ${processed} meeting(s)`);
        await forceFlushSnapshot();
      }
    } catch (err) {
      console.error("[poll-ingest] Zoom API meeting sync failed:", err instanceof Error ? err.message : err);
    }
  });

  // ── Write health metadata ───────────────────────────────────────────────────
  // Updates health-meta.json with the current poll timestamp and source counts
  // so the system health panel can show "last ingested Xm ago".
  // Runs after the response is sent — non-blocking.
  after(async () => {
    try {
      const existing = await readUserStore<HealthMeta>(username, HEALTH_META_FILE, {});
      await writeUserStore<HealthMeta>(username, HEALTH_META_FILE, {
        ...existing,
        lastPollAt: new Date().toISOString(),
        lastPollSources: {
          email:        emails.length - zoomEmailIds.size,
          slack:        slacks.length,
          calendar:     calEvents.length,
          zoom_email:   zoomEmails.length,
          outlook_email: outlookEmails.length,
          teams:        teamsMessages.length,
        },
      });
    } catch (e) {
      // Non-fatal — health meta is advisory only.
      console.warn("[poll-ingest] Failed to write health-meta:", e instanceof Error ? e.message : e);
    }
  });

  return NextResponse.json({
    ingested,
    draftsGenerated: draftEvents.length,
    scanned: payloads.length,
    sources: {
      email: emails.length - zoomEmailIds.size,
      slack: slacks.length,
      calendar: calEvents.length,
      zoom_email: zoomEmails.length,
      outlook_email: outlookEmails.length,
      teams: teamsMessages.length,
    },
    zoom: {
      detected: zoomEmails.length,
      ingested: zoomIngested,
    },
    // Intelligence queues are async fire-and-forget.  Actual materialization
    // counts are emitted to server logs since they complete after this response.
    emailIntelligence: {
      queued: emailsToClassify.length,
    },
    slackIntelligence: {
      queued: slacksToClassify.length,
    },
    teamsIntelligence: {
      queued: teamsToClassify.length,
    },
    eventsCompacted,
  });
}

// Vercel cron jobs call GET — expose the same logic so the 15-min cron works.
export { POST as GET };
