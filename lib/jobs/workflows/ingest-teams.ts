/**
 * Durable Teams ingest workflow.
 *
 * Replaces fire-and-forget after() calls for Teams messages with a
 * durable, retryable workflow.
 *
 * FatalError → do not retry (e.g. permanent auth failure)
 * Any other thrown error → retry automatically
 */
import { FatalError } from "workflow";
import type { IngestTeamsPayload } from "../types";

// ── Step: process a single Teams message/thread ───────────────────────────────

async function processTeamsStep(username: string, payload: IngestTeamsPayload): Promise<void> {
  "use step";

  console.log(
    `[ingest-teams] step start: ${payload.externalId} channel=${payload.channelName} username=${username}`
  );

  const { fetchTeamsThread, formatTeamsTranscript } =
    await import("@/lib/teams/fetch-thread");
  const { classifyTeams, shouldMaterializeSlack: shouldMaterializeTeams } =
    await import("@/lib/teams/classify-teams");
  const { materializeTeamsIntelligence } =
    await import("@/lib/teams/materialize-teams");
  const { hashContent } = await import("@/lib/ingest/content-hash");
  const { isHashUnchanged, recordIngest } = await import("@/lib/ingest/index");
  const { appendAuditEntries, auditSkipped } = await import("@/lib/ingest/audit-log");

  const {
    chatOrChannelId,
    channelId,
    messageId,
    externalId,
    eventId,
    channelName,
    from,
    date,
    isDM,
    isMention,
    bodyFallback,
  } = payload;

  const threadMessages = await fetchTeamsThread(username, chatOrChannelId, channelId, messageId);
  const transcript =
    threadMessages.length > 0
      ? formatTeamsTranscript(threadMessages, channelName)
      : `Channel: ${channelName}\n\n${from}: ${bodyFallback || ""}`;

  const contentHash = hashContent(channelName, transcript);
  const unchanged = await isHashUnchanged(username, externalId, contentHash);
  if (unchanged) {
    console.log(`[ingest-teams] ${externalId} unchanged (hash match) — skipping`);
    void appendAuditEntries(username, [
      auditSkipped(externalId, "action", `Teams content unchanged for ${externalId}`),
    ]);
    return;
  }

  const intel = await classifyTeams({ channelName, transcript, isDM, isMention, date });

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
    actionIds: result.auditEntries
      .filter((e) => e.itemType === "action" && e.itemId)
      .map((e) => e.itemId!),
    decisionIds: result.auditEntries
      .filter((e) => e.itemType === "decision" && e.itemId)
      .map((e) => e.itemId!),
    memoryIds: result.auditEntries
      .filter((e) => e.itemType === "memory" && e.itemId)
      .map((e) => e.itemId!),
  });
  void appendAuditEntries(username, result.auditEntries);

  console.log(`[ingest-teams] step done: ${externalId}`);
}

// ── Workflow orchestrator ─────────────────────────────────────────────────────

export async function ingestTeamsWorkflow(
  username: string,
  payload: IngestTeamsPayload
): Promise<void> {
  "use workflow";

  console.log(
    `[ingest-teams] workflow start: ${payload.externalId} channel=${payload.channelName}`
  );
  try {
    await processTeamsStep(username, payload);
    console.log(`[ingest-teams] workflow complete: ${payload.externalId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Permanent failures should not be retried
    if (
      msg.includes("InvalidAuthenticationToken") ||
      msg.includes("Authorization_RequestDenied") ||
      msg.includes("itemNotFound")
    ) {
      throw new FatalError(`Teams message ${payload.externalId} permanently failed: ${msg}`);
    }
    throw err; // transient — workflow runtime will retry
  }
}
