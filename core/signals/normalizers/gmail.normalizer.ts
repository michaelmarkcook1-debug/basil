/**
 * Gmail Signal Normalizer
 *
 * Maps raw Gmail ingest inputs (ProcessEmailOpts + fetched body) into a
 * canonical SignalEvent. This is a PURE, DETERMINISTIC function — no AI,
 * no async calls, no side effects. The AI classification pass happens later
 * during materialization.
 *
 * Used by the shadow runner to produce a SignalEvent alongside the old
 * pipeline's output, so we can compare them during the Week 1 shadow phase.
 *
 * When signalEvent_active is true (future weeks), this becomes the source
 * of truth that replaces the direct-to-store writes in processRegularEmail.
 *
 * Guardrails:
 *   - No AI calls
 *   - No database reads or writes
 *   - No network calls
 *   - Returns SignalEvent or throws — never swallows errors silently
 */

import { hashContent } from "@/lib/ingest/content-hash";
import {
  buildTrustEnvelope,
  DECAY_HALF_LIFE_DAYS,
} from "@/core/primitives/trust-envelope";
import type { SignalEvent, EntityRef } from "@/core/primitives/signal-event";
import type { ProcessEmailOpts } from "@/lib/email/process-gmail-message";

// ── Input shape ───────────────────────────────────────────────────────────────

export interface GmailNormalizerInput {
  opts: ProcessEmailOpts;
  /** Plain-text body (HTML already stripped by the caller). */
  body: string;
  /** Resolved send date (ISO8601). */
  date: string;
  /** Whether the sender is a known contact. Affects trust tier. */
  senderIsKnown?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Best-effort parse of a "Name <email>" or bare email string.
 */
function parseFrom(raw: string): EntityRef {
  const bracketMatch = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (bracketMatch) {
    return {
      rawName: bracketMatch[1].trim(),
      rawEmail: bracketMatch[2].trim().toLowerCase(),
      role: "sender",
    };
  }
  // Bare email or display name only
  const isEmail = raw.includes("@");
  return {
    rawName: raw.trim(),
    rawEmail: isEmail ? raw.trim().toLowerCase() : undefined,
    role: "sender",
  };
}

/**
 * Derive a short snippet from body text (≤200 chars, truncated at word boundary).
 */
function deriveSnippet(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 200) return trimmed;
  const cut = trimmed.slice(0, 200);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 150 ? cut.slice(0, lastSpace) + "…" : cut + "…";
}

// ── Normalizer ────────────────────────────────────────────────────────────────

/**
 * Normalize a Gmail message into a canonical SignalEvent.
 *
 * Pure function — no I/O.
 *
 * @param input  Gmail opts, fetched body, resolved date, and sender-known flag
 * @returns      Fully populated SignalEvent (category defaults to "unknown"
 *               until the AI classification pass runs)
 */
export function normalizeGmailSignal(input: GmailNormalizerInput): SignalEvent {
  const { opts, body, date, senderIsKnown = true } = input;
  const { externalId, subject, from, eventId } = opts;

  // ── Deterministic ID ───────────────────────────────────────────────────────
  const rawHash = hashContent(subject, body);
  const signalId = hashContent("gmail", externalId, rawHash);

  // ── Participants ───────────────────────────────────────────────────────────
  const sender = parseFrom(from);
  const participants: EntityRef[] = [sender];

  // ── Trust envelope ─────────────────────────────────────────────────────────
  const trust = buildTrustEnvelope({
    source: "gmail",
    sourceRef: externalId,
    confidence: 0.75,   // base confidence for a classified email (pre-AI pass)
    halfLifeDays: DECAY_HALF_LIFE_DAYS.email,
    senderIsKnown,
    artifactType: "memory",
    extractedBy: "rule",
  });

  // ── Assemble ───────────────────────────────────────────────────────────────
  const now = new Date().toISOString();

  const event: SignalEvent = {
    id: signalId,
    source: "gmail",
    externalId,
    sourceRef: externalId,  // e.g. "gmail:msg_abc123"
    rawHash,
    eventType: "email",
    category: "unknown",    // AI classification pass will populate this
    occurredAt: date,
    ingestedAt: now,
    title: subject,
    body: body.slice(0, 8_000),  // cap at 8 KB to keep the event store lean
    snippet: deriveSnippet(body),
    participants,
    projects: [],
    actions: [],
    decisions: [],
    memories: [],
    trust,
    relatedEventIds: [],
    basilEventId: eventId,
    actionIds: [],
    decisionIds: [],
    memoryIds: [],
  };

  return event;
}
