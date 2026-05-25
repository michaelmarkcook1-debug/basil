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
  const { getSelfIdentity } = await import("@/lib/self-identity");

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

  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));
  const selfDisplayName = selfIdentity.names[0] ?? undefined;

  const threadMessages = await fetchSlackThread(username, channelId, messageTs);
  const transcript =
    threadMessages.length > 0
      ? formatThreadTranscript(threadMessages, channelName, selfDisplayName)
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
    isDM,
  });

  const actionIds = result.auditEntries
    .filter((e) => e.itemType === "action" && e.itemId)
    .map((e) => e.itemId!);
  const decisionIds = result.auditEntries
    .filter((e) => e.itemType === "decision" && e.itemId)
    .map((e) => e.itemId!);
  const memoryIds = result.auditEntries
    .filter((e) => e.itemType === "memory" && e.itemId)
    .map((e) => e.itemId!);

  void recordIngest(username, {
    sourceRef: externalId,
    hash: contentHash,
    actionIds,
    decisionIds,
    memoryIds,
  });
  void appendAuditEntries(username, result.auditEntries);

  // ── Primitive pipeline (Week 3 gated) ────────────────────────────────────
  // signalEvent_shadow → observe + log diffs (old path remains authoritative)
  // signalEvent_active → dual-write SignalEvent alongside old stores
  // Called directly (no extra after()) — we're already inside a durable step.
  const { getFlags } = await import("@/core/feature-flags");
  const flags = await getFlags(username);
  const normInput = { payload, transcript, senderIsKnown: true };

  if (flags.signalEvent_shadow) {
    const { runSlackShadow } = await import("@/core/ingestion/slack-shadow-runner");
    await runSlackShadow(normInput, contentHash, username);
  }

  if (flags.signalEvent_active) {
    const { normalizeSlackSignal } = await import("@/core/signals/normalizers/slack.normalizer");
    const { enrichAndWriteSignal } = await import("@/core/ingestion/signal-pipeline");
    try {
      const signal = normalizeSlackSignal(normInput);
      signal.actionIds = actionIds;
      signal.decisionIds = decisionIds;
      signal.memoryIds = memoryIds;
      signal.category = (intel.category as typeof signal.category) ?? "unknown";
      signal.actions = (intel.actions ?? []).map((a) => ({
        text: a.text,
        dueDate: a.dueDate,
        priority: a.priority,
      }));
      signal.decisions = (intel.decisions ?? []).map((d) => ({
        text: d.text,
        title: d.title,
        decidedBy: d.decidedBy,
        rationale: d.rationale,
        alternatives: d.alternatives,
        consequences: d.consequences,
      }));
      await enrichAndWriteSignal(username, signal, flags);
    } catch (err) {
      console.error(
        `[ingest-slack] signalEvent_active pipeline failed for ${externalId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

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
