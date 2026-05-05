/**
 * Durable Gmail ingest workflow.
 *
 * Replaces the fire-and-forget after() calls in the Gmail webhook with a
 * durable, retryable workflow.  Steps have full Node.js access and are
 * automatically retried on transient failures.
 *
 * FatalError → do not retry (e.g. body fetch returned 404)
 * Any other thrown error → retry automatically
 */
import { FatalError } from "workflow";
import type { IngestGmailPayload } from "../types";

// ── Step: process a single Gmail message ──────────────────────────────────────

async function processGmailStep(username: string, payload: IngestGmailPayload): Promise<void> {
  "use step";

  const kind = payload.isZoom ? "zoom" : "regular";
  console.log(`[ingest-gmail] step start: ${kind} ${payload.externalId} username=${username}`);

  const { processRegularEmail, processZoomEmail } = await import(
    "@/lib/email/process-gmail-message"
  );

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

  console.log(`[ingest-gmail] step done: ${kind} ${payload.externalId}`);
}

// ── Workflow orchestrator ─────────────────────────────────────────────────────

export async function ingestGmailWorkflow(
  username: string,
  payload: IngestGmailPayload
): Promise<void> {
  "use workflow";

  console.log(`[ingest-gmail] workflow start: ${payload.externalId} isZoom=${payload.isZoom}`);
  try {
    await processGmailStep(username, payload);
    console.log(`[ingest-gmail] workflow complete: ${payload.externalId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Permanent failures (e.g. message not found) should not be retried
    if (
      msg.includes("404") ||
      msg.includes("Message not found") ||
      msg.includes("invalid message id")
    ) {
      throw new FatalError(`Gmail message ${payload.externalId} not found: ${msg}`);
    }
    throw err; // transient — workflow runtime will retry
  }
}
