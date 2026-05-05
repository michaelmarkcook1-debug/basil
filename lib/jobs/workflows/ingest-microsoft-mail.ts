/**
 * Durable Microsoft Mail ingest workflow.
 *
 * Replaces fire-and-forget after() calls in the Microsoft mail webhook with a
 * durable, retryable workflow.
 *
 * FatalError → do not retry (e.g. message deleted, token revoked)
 * Any other thrown error → retry automatically
 */
import { FatalError } from "workflow";
import type { IngestMicrosoftMailPayload } from "../types";

// ── Step: process a single Outlook message ────────────────────────────────────

async function processMicrosoftMailStep(
  username: string,
  payload: IngestMicrosoftMailPayload
): Promise<void> {
  "use step";

  console.log(
    `[ingest-microsoft-mail] step start: ${payload.externalId} username=${username}`
  );

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

  console.log(`[ingest-microsoft-mail] step done: ${payload.externalId}`);
}

// ── Workflow orchestrator ─────────────────────────────────────────────────────

export async function ingestMicrosoftMailWorkflow(
  username: string,
  payload: IngestMicrosoftMailPayload
): Promise<void> {
  "use workflow";

  console.log(`[ingest-microsoft-mail] workflow start: ${payload.externalId}`);
  try {
    await processMicrosoftMailStep(username, payload);
    console.log(`[ingest-microsoft-mail] workflow complete: ${payload.externalId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Permanent failures should not be retried
    if (
      msg.includes("404") ||
      msg.includes("itemNotFound") ||
      msg.includes("InvalidAuthenticationToken") ||
      msg.includes("token_revoked")
    ) {
      throw new FatalError(
        `Microsoft mail message ${payload.externalId} permanently failed: ${msg}`
      );
    }
    throw err; // transient — workflow runtime will retry
  }
}
