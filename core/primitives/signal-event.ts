/**
 * Primitive 1 — SignalEvent
 *
 * The atomic unit of intelligence in Basil. Every email, message, meeting,
 * document change, task update, and calendar event is first normalized into
 * a SignalEvent before any AI processing, ranking, or materialization occurs.
 *
 * Design constraints:
 *   - Immutable after creation — never mutate, create a new version instead
 *   - Deterministic ID — sha256 of (source + externalId + rawHash)
 *   - No AI in normalization — normalizers are pure data-mapping functions
 *   - Trust is attached at normalization time, not materialization time
 *
 * Relationship to existing stores:
 *   - Actions, Decisions, Memory records are DERIVED from SignalEvents
 *   - SignalEvents are the provenance record for those derived artifacts
 *   - Stored in "sage-signal-events.json" (new, gated on signalEvent_active flag)
 */

// ── Source ────────────────────────────────────────────────────────────────────

/**
 * Canonical set of signal sources. Mirrors SOURCE_WEIGHTS in TrustEnvelope.
 */
export type SignalSource =
  | "gmail"
  | "outlook"
  | "slack"
  | "teams"
  | "zoom"
  | "whatsapp"
  | "calendar"
  | "drive"
  | "onedrive"
  | "linear";

// ── Signal type ───────────────────────────────────────────────────────────────

/**
 * Signal classification — what kind of intelligence event this represents.
 */
export type SignalEventType =
  | "email"            // Inbox email (gmail, outlook)
  | "message"          // Chat message (slack, teams, whatsapp)
  | "meeting"          // Zoom/calendar meeting record
  | "document_change"  // File activity (drive, onedrive)
  | "issue"            // Task/issue update (linear)
  | "calendar_event";  // Calendar entry (upcoming or past)

// ── Entity reference ──────────────────────────────────────────────────────────

/**
 * A lightweight reference to a person or entity that participated in the signal.
 * Resolved to CanonicalIdentity when canonicalIdentity_active is true.
 */
export interface EntityRef {
  /** Raw display name or email as it appeared in the source. */
  rawName: string;
  /** Raw email address if available. */
  rawEmail?: string;
  /** Role in this signal (sender, recipient, attendee, assignee, etc.). */
  role: "sender" | "recipient" | "attendee" | "assignee" | "reporter" | "mentioned";
  /** Resolved canonical identity ID — populated after CanonicalIdentity pass. */
  canonicalId?: string;
}

// ── Extracted intelligence ────────────────────────────────────────────────────

/** A task or commitment extracted from the signal. */
export interface ExtractedAction {
  text: string;
  dueDate?: string;     // ISO8601 or natural language
  priority?: "high" | "medium" | "low";
  assignee?: string;    // raw name/email
}

/** A decision or confirmed outcome extracted from the signal. */
export interface ExtractedDecision {
  text: string;
  title?: string;
  decidedBy?: string;
  rationale?: string;
  alternatives?: string[];
  consequences?: string[];
}

/** A piece of relationship or context memory extracted from the signal. */
export interface ExtractedMemory {
  text: string;
  /** Category tag for the memory (e.g. "relationship", "preference", "fact"). */
  tag?: string;
}

// ── Signal category ───────────────────────────────────────────────────────────

/**
 * High-level semantic category. Mirrors EmailCategory from classify-email.
 * Extended here to cover non-email sources.
 */
export type SignalCategory =
  | "action_required"
  | "decision_made"
  | "relationship_signal"
  | "commercial_signal"
  | "meeting_intelligence"
  | "document_activity"
  | "issue_update"
  | "low_value_noise"
  | "unknown";

// ── SignalEvent ───────────────────────────────────────────────────────────────

import type { TrustEnvelope } from "./trust-envelope";
import type { RankedSignal } from "./ranked-signal";

export interface SignalEvent {
  // ── Identity ───────────────────────────────────────────────────────────────

  /**
   * Deterministic ID — sha256 of (source + externalId + rawHash), hex-truncated to 32 chars.
   * Stable across re-ingestion of the same content.
   */
  id: string;

  /**
   * Source system this signal originated from.
   */
  source: SignalSource;

  /**
   * Raw external identifier as provided by the source system.
   * Examples: "msg_abc123" (gmail), "C01ABC:123456.789" (slack)
   */
  externalId: string;

  /**
   * Human-readable source reference for provenance display.
   * Examples: "gmail:msg_abc123", "slack:C01ABC:123456.789"
   */
  sourceRef: string;

  /**
   * SHA-256 hash of the raw content. Used for idempotency — if rawHash
   * matches the stored hash for sourceRef, skip re-processing.
   */
  rawHash: string;

  // ── Classification ─────────────────────────────────────────────────────────

  /** What kind of event this is. */
  eventType: SignalEventType;

  /** Semantic category. Populated by the AI classification pass. */
  category: SignalCategory;

  // ── Timing ─────────────────────────────────────────────────────────────────

  /** When this signal actually occurred (ISO8601). May differ from ingestedAt. */
  occurredAt: string;

  /** When Basil first processed this signal (ISO8601). Always present. */
  ingestedAt: string;

  // ── Content ────────────────────────────────────────────────────────────────

  /** Subject line, title, or first-line summary. */
  title: string;

  /** Plain-text body, stripped of HTML. May be truncated for very long content. */
  body: string;

  /**
   * Short preview for display (≤200 chars). Derived from body if not provided
   * by the source.
   */
  snippet: string;

  // ── Participants ───────────────────────────────────────────────────────────

  /**
   * Everyone who participated in or was mentioned by this signal.
   * Sender is always first (role: "sender") when applicable.
   */
  participants: EntityRef[];

  // ── Project tags ───────────────────────────────────────────────────────────

  /**
   * Project identifiers this signal was tagged to.
   * Populated by the project-tagging pass (future).
   */
  projects: string[];

  // ── Extracted intelligence ─────────────────────────────────────────────────

  /** Actions extracted from this signal. */
  actions: ExtractedAction[];

  /** Decisions extracted from this signal. */
  decisions: ExtractedDecision[];

  /** Memory items extracted from this signal. */
  memories: ExtractedMemory[];

  // ── Trust ──────────────────────────────────────────────────────────────────

  /**
   * Trust envelope — confidence, provenance, freshness, tier.
   * Always present. Built at normalization time.
   */
  trust: TrustEnvelope;

  /**
   * Ranking score — attached by the signal ranker when ranking_active is true.
   * Undefined until the ranking pass runs.
   */
  ranking?: RankedSignal;

  // ── Relationships ──────────────────────────────────────────────────────────

  /**
   * Thread or conversation ID this signal belongs to.
   * Null if no threading information is available.
   */
  threadId?: string;

  /**
   * IDs of other SignalEvents that are directly related to this one
   * (e.g. replies in a thread, follow-up emails, linked issues).
   */
  relatedEventIds: string[];

  // ── Provenance links ───────────────────────────────────────────────────────

  /**
   * BasilEvent ID that triggered this signal's creation.
   * Links back to the existing event store.
   */
  basilEventId?: string;

  /**
   * IDs of Action records materialized from this signal.
   */
  actionIds: string[];

  /**
   * IDs of Decision records materialized from this signal.
   */
  decisionIds: string[];

  /**
   * IDs of Memory records materialized from this signal.
   */
  memoryIds: string[];
}
