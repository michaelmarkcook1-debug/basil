/**
 * Durable Slack ingest workflow.
 *
 * Replaces the fire-and-forget after() block in the Slack webhook with a
 * durable, retryable workflow.
 *
 * FatalError → do not retry (e.g. channel not found, permanent auth error)
 * Any other thrown error → retry automatically
 */
import { FatalError } from "workflow";
import type { IngestSlackPayload } from "../types";

// ── Step: process a single Slack message/thread ───────────────────────────────

async function processSlackStep(username: string, payload: IngestSlackPayload): Promise<void> {
  "use step";

  console.log(
    `[ingest-slack] step start: ${payload.externalId} channel=${payload.channelName} username=${username}`
  );

  const { fetchSlackThread, formatThreadTranscript } =
    await import("@/lib/slack/fetch-thread");
  const { classifySlack, shouldMaterializeSlack } =
    await import("@/lib/slack/classify-slack");
  const { materializeSlackIntelligence } =
    await import("@/lib/slack/materialize-slack");
  const { hashContent } = await import("@/lib/ingest/content-hash");
  const { isHashUnchanged, recordIngest } = await import("@/lib/ingest/index");
  const { appendAuditEntries, auditSkipped } = await import("@/lib/ingest/audit-log");

  const {
    channelId,
    messageTs,
    externalId,
    eventId,
    channelName,
    from,
    date,
    isDM,
    isMention,
    bodyFallback,
  } = payload;

  const threadMessages = await fetchSlackThread(username, channelId, messageTs);
  const transcript =
    threadMessages.length > 0
      ? formatThreadTranscript(threadMessages, channelName)
      : `Channel: ${channelName}\n\n${from}: ${bodyFallback || ""}`;

  const contentHash = hashContent(channelName, transcript);
  const unchanged = await isHashUnchanged(username, externalId, contentHash);
  if (unchanged) {
    console.log(`[ingest-slack] ${externalId} unchanged (hash match) — skipping`);
    void appendAuditEntries(username, [
      auditSkipped(externalId, "action", `Slack content unchanged for ${externalId}`),
    ]);
    return;
  }

  const intel = await classifySlack({
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

  console.log(`[ingest-slack] step done: ${externalId}`);
}

// ── Workflow orchestrator ─────────────────────────────────────────────────────

export async function ingestSlackWorkflow(
  username: string,
  payload: IngestSlackPayload
): Promise<void> {
  "use workflow";

  console.log(
    `[ingest-slack] workflow start: ${payload.externalId} channel=${payload.channelName}`
  );
  try {
    await processSlackStep(username, payload);
    console.log(`[ingest-slack] workflow complete: ${payload.externalId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Permanent failures should not be retried
    if (
      msg.includes("channel_not_found") ||
      msg.includes("not_in_channel") ||
      msg.includes("invalid_auth") ||
      msg.includes("token_revoked")
    ) {
      throw new FatalError(`Slack message ${payload.externalId} permanently failed: ${msg}`);
    }
    throw err; // transient — workflow runtime will retry
  }
}
