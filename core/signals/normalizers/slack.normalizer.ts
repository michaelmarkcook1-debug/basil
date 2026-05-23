/**
 * Slack Signal Normalizer
 *
 * Maps raw Slack ingest inputs (IngestSlackPayload + fetched transcript)
 * into a canonical SignalEvent. Pure, deterministic — no AI, no I/O.
 *
 * Key differences from Gmail normalizer:
 *   - Source is "slack", eventType is "message"
 *   - threadId = payload.messageTs (Slack's stable thread root timestamp)
 *   - isDM elevates source weight (lower noise, higher fidelity signal)
 *   - Transcript (full thread) is the body, not a single message
 *   - Channel name is the title (not a subject line)
 *   - Trust half-life: DECAY_HALF_LIFE_DAYS.message = 7 days
 *
 * Guardrails:
 *   - No AI calls, no async, no database
 *   - Returns SignalEvent or throws — never silently fails
 */

import { hashContent } from "@/lib/ingest/content-hash";
import {
  buildTrustEnvelope,
  DECAY_HALF_LIFE_DAYS,
} from "@/core/primitives/trust-envelope";
import type { SignalEvent, EntityRef } from "@/core/primitives/signal-event";
import type { IngestSlackPayload } from "@/lib/jobs/types";

// ── Input shape ───────────────────────────────────────────────────────────────

export interface SlackNormalizerInput {
  payload: IngestSlackPayload;
  /**
   * Full thread transcript (already formatted by formatThreadTranscript).
   * This is the body of the signal — capped to 8KB by the store.
   */
  transcript: string;
  /** Whether the sender is a known contact. Affects trust tier. */
  senderIsKnown?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a Slack display name into an EntityRef.
 * Slack provides display names, not emails — rawEmail left undefined
 * until CanonicalIdentity resolution pass.
 */
function parseSender(from: string, isDM: boolean): EntityRef {
  return {
    rawName: from.trim(),
    role: "sender",
    // Slack doesn't expose email in webhook payloads — resolved later
    // via CanonicalIdentity when canonicalIdentity_active is true
  };
}

/**
 * Build a title for the signal from channel context.
 * DM: "DM from {name}", Mention: "#{channel} mention", else "#{channel}"
 */
function buildTitle(payload: IngestSlackPayload): string {
  const { channelName, from, isDM, isGroupDM, isMention } = payload;
  if (isDM) return `DM from ${from}`;
  if (isGroupDM) return `Group DM with ${from}`;
  if (isMention) return `#${channelName} — mention from ${from}`;
  return `#${channelName}`;
}

/**
 * Derive snippet from transcript (≤200 chars, word-boundary truncation).
 */
function deriveSnippet(transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= 200) return trimmed;
  const cut = trimmed.slice(0, 200);
  const lastNewline = cut.lastIndexOf("\n");
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = Math.max(lastNewline, lastSpace);
  return boundary > 100 ? cut.slice(0, boundary) + "…" : cut + "…";
}

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Normalize a Slack thread into a canonical SignalEvent.
 *
 * Pure function — no I/O.
 *
 * @param input  Slack payload, fetched transcript, and sender-known flag
 * @returns      Fully populated SignalEvent (category "unknown" until AI pass)
 */
export function normalizeSlackSignal(input: SlackNormalizerInput): SignalEvent {
  const { payload, transcript, senderIsKnown = true } = input;
  const {
    externalId,
    channelName,
    from,
    date,
    eventId,
    messageTs,
    isDM,
    isGroupDM,
    isMention,
  } = payload;

  // ── Deterministic ID ───────────────────────────────────────────────────────
  const rawHash = hashContent(channelName, transcript);
  const signalId = hashContent("slack", externalId, rawHash);

  // ── Participants ───────────────────────────────────────────────────────────
  const sender = parseSender(from, isDM);
  const participants: EntityRef[] = [sender];

  // ── Trust — DMs get higher base confidence (less noise than public channels) ─
  const baseConfidence = isDM || isGroupDM ? 0.80 : isMention ? 0.75 : 0.65;

  const trust = buildTrustEnvelope({
    source: "slack",
    sourceRef: externalId,
    confidence: baseConfidence,
    halfLifeDays: DECAY_HALF_LIFE_DAYS.message,
    senderIsKnown,
    artifactType: "memory",
    extractedBy: "rule",
  });

  // ── Assemble ───────────────────────────────────────────────────────────────
  const now = new Date().toISOString();

  const event: SignalEvent = {
    id: signalId,
    source: "slack",
    externalId,
    sourceRef: externalId,
    rawHash,
    eventType: "message",
    category: "unknown",      // AI classification pass populates this
    occurredAt: date,
    ingestedAt: now,
    title: buildTitle(payload),
    body: transcript.slice(0, 8_000),
    snippet: deriveSnippet(transcript),
    participants,
    projects: [],
    actions: [],
    decisions: [],
    memories: [],
    trust,
    threadId: messageTs,      // Slack thread root timestamp = stable thread key
    relatedEventIds: [],
    basilEventId: eventId,
    actionIds: [],
    decisionIds: [],
    memoryIds: [],
  };

  return event;
}
