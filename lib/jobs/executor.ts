/**
 * Job executor — central dispatch for all job types.
 *
 * Called by:
 *  - POST /api/jobs/handler (QStash delivery in production)
 *  - after() fallback in lib/jobs/queue.ts (local dev)
 *
 * Each executor function is responsible for:
 *  1. Doing the actual work (calling the appropriate lib function)
 *  2. Updating the job record status on success/failure
 *
 * Important: executors MUST be idempotent — QStash delivers at-least-once,
 * and the content-hash idempotency layer in lib/ingest ensures no duplicates
 * are created when a job is retried.
 */

import { updateJobRecord } from "./store";
import type { JobType, JobPayloadMap } from "./types";

/**
 * Execute a job and update its record.
 * Returns a Promise that resolves when the job completes (success or failure).
 */
export async function executeJob<T extends JobType>(
  type: T,
  username: string,
  payload: JobPayloadMap[T],
  jobId: string
): Promise<void> {
  const now = new Date().toISOString();
  await updateJobRecord(username, jobId, {
    status: "running",
    updatedAt: now,
  });

  try {
    await dispatch(type, username, payload);
    await updateJobRecord(username, jobId, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await updateJobRecord(username, jobId, {
      status: "failed",
      lastError: errMsg,
      finishedAt: new Date().toISOString(),
    });
    // Re-throw so QStash knows to retry (non-2xx response from handler)
    throw err;
  }
}

// ── Job type dispatch ─────────────────────────────────────────────────────────

async function dispatch<T extends JobType>(
  type: T,
  username: string,
  payload: JobPayloadMap[T]
): Promise<void> {
  switch (type) {
    case "ingest.gmail":
      return execIngestGmail(username, payload as JobPayloadMap["ingest.gmail"]);
    case "ingest.slack":
      return execIngestSlack(username, payload as JobPayloadMap["ingest.slack"]);
    case "ingest.zoom":
      return execIngestZoom(username, payload as JobPayloadMap["ingest.zoom"]);
    case "ingest.teams":
      return execIngestTeams(username, payload as JobPayloadMap["ingest.teams"]);
    case "ingest.microsoft.mail":
      return execIngestMicrosoftMail(username, payload as JobPayloadMap["ingest.microsoft.mail"]);
    case "ingest.calendar":
    case "ingest.microsoft.calendar":
    case "classify.action":
    case "classify.decision":
    case "classify.memory":
    case "generate.briefing":
    case "generate.digest":
    case "generate.meetingPrep":
    case "import.whatsapp":
    case "sync.aiProjects":
      // Stub — these job types are scaffolded for future implementation
      console.log(`[jobs/executor] ${type} not yet implemented (stub)`);
      return;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown job type: ${_exhaustive}`);
    }
  }
}

// ── Individual job executors ──────────────────────────────────────────────────

async function execIngestGmail(
  username: string,
  payload: JobPayloadMap["ingest.gmail"]
): Promise<void> {
  const { processRegularEmail, processZoomEmail } =
    await import("@/lib/email/process-gmail-message");

  if (payload.isZoom) {
    await processZoomEmail({
      username,
      gmailId: payload.gmailId,
      externalId: payload.externalId,
      eventId: payload.eventId,
      subject: payload.subject,
      dateFallback: payload.dateFallback,
    });
  } else {
    await processRegularEmail({
      username,
      gmailId: payload.gmailId,
      externalId: payload.externalId,
      eventId: payload.eventId,
      subject: payload.subject,
      from: payload.from,
      snippetFallback: payload.snippetFallback,
      dateFallback: payload.dateFallback,
    });
  }
}

async function execIngestSlack(
  username: string,
  payload: JobPayloadMap["ingest.slack"]
): Promise<void> {
  const { fetchSlackThread, formatThreadTranscript } =
    await import("@/lib/slack/fetch-thread");
  const { classifySlack, shouldMaterializeSlack } =
    await import("@/lib/slack/classify-slack");
  const { materializeSlackIntelligence } =
    await import("@/lib/slack/materialize-slack");
  const { hashContent } = await import("@/lib/ingest/content-hash");
  const { isHashUnchanged, recordIngest } = await import("@/lib/ingest/index");
  const { appendAuditEntries, auditSkipped } = await import("@/lib/ingest/audit-log");

  const { channelId, messageTs, externalId, eventId, channelName, from, date, isDM, isMention, bodyFallback } = payload;

  const threadMessages = await fetchSlackThread(username, channelId, messageTs);
  const transcript =
    threadMessages.length > 0
      ? formatThreadTranscript(threadMessages, channelName)
      : `Channel: ${channelName}\n\n${from}: ${bodyFallback || ""}`;

  const contentHash = hashContent(channelName, transcript);
  const unchanged = await isHashUnchanged(username, externalId, contentHash);
  if (unchanged) {
    void appendAuditEntries(username, [
      auditSkipped(externalId, "action", `Slack content unchanged for ${externalId}`),
    ]);
    return;
  }

  const intel = await classifySlack({
    username,
    channelName,
    transcript,
    isDM,
    isMention,
    date,
  });

  if (!shouldMaterializeSlack(intel)) {
    void recordIngest(username, { sourceRef: externalId, hash: contentHash });
    return;
  }

  const result = await materializeSlackIntelligence({
    intelligence: intel,
    sourceRef: externalId,
    eventId,
    channelName,
    from,
    date,
    username,
  });

  void recordIngest(username, {
    sourceRef: externalId,
    hash: contentHash,
    actionIds: result.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
    decisionIds: result.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
    memoryIds: result.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
  });
  void appendAuditEntries(username, result.auditEntries);
}

async function execIngestZoom(
  username: string,
  payload: JobPayloadMap["ingest.zoom"]
): Promise<void> {
  // Zoom meeting processing requires a full ZoomMeeting object — this job type
  // is a stub; the actual meeting data needs to be fetched from the Zoom API
  // before dispatching. Implement when the Zoom poll-ingest path is refactored.
  console.log(`[jobs/executor] ingest.zoom stub for meetingId=${payload.meetingId} (not yet implemented)`);
}

async function execIngestTeams(
  username: string,
  payload: JobPayloadMap["ingest.teams"]
): Promise<void> {
  const { fetchTeamsThread, formatTeamsTranscript } =
    await import("@/lib/teams/fetch-thread");
  const { classifyTeams, shouldMaterializeSlack: shouldMaterializeTeams } =
    await import("@/lib/teams/classify-teams");
  const { materializeTeamsIntelligence } =
    await import("@/lib/teams/materialize-teams");
  const { hashContent } = await import("@/lib/ingest/content-hash");
  const { isHashUnchanged, recordIngest } = await import("@/lib/ingest/index");
  const { appendAuditEntries, auditSkipped } = await import("@/lib/ingest/audit-log");

  const { chatOrChannelId, channelId, messageId, externalId, eventId, channelName, from, date, isDM, isMention, bodyFallback } = payload;

  const threadMessages = await fetchTeamsThread(username, chatOrChannelId, channelId, messageId);
  const transcript =
    threadMessages.length > 0
      ? formatTeamsTranscript(threadMessages, channelName)
      : `Channel: ${channelName}\n\n${from}: ${bodyFallback || ""}`;

  const contentHash = hashContent(channelName, transcript);
  const unchanged = await isHashUnchanged(username, externalId, contentHash);
  if (unchanged) {
    void appendAuditEntries(username, [
      auditSkipped(externalId, "action", `Teams content unchanged for ${externalId}`),
    ]);
    return;
  }

  const intel = await classifyTeams({ username, channelName, transcript, isDM, isMention, date });

  if (!shouldMaterializeTeams(intel)) {
    void recordIngest(username, { sourceRef: externalId, hash: contentHash });
    return;
  }

  const result = await materializeTeamsIntelligence({
    intelligence: intel,
    sourceRef: externalId,
    eventId,
    channelName,
    from,
    date,
    username,
  });

  void recordIngest(username, {
    sourceRef: externalId,
    hash: contentHash,
    actionIds: result.auditEntries.filter((e) => e.itemType === "action" && e.itemId).map((e) => e.itemId!),
    decisionIds: result.auditEntries.filter((e) => e.itemType === "decision" && e.itemId).map((e) => e.itemId!),
    memoryIds: result.auditEntries.filter((e) => e.itemType === "memory" && e.itemId).map((e) => e.itemId!),
  });
  void appendAuditEntries(username, result.auditEntries);
}

async function execIngestMicrosoftMail(
  username: string,
  payload: JobPayloadMap["ingest.microsoft.mail"]
): Promise<void> {
  const { processRegularEmail } = await import("@/lib/email/process-gmail-message");
  const { getOutlookMessageBody } = await import("@/lib/microsoft/outlook-mail");

  await processRegularEmail({
    username,
    gmailId: payload.messageId,
    externalId: payload.externalId,
    eventId: payload.eventId,
    subject: payload.subject,
    from: payload.from,
    snippetFallback: payload.snippetFallback,
    bodyFetcher: () => getOutlookMessageBody(username, payload.messageId),
  });
}
