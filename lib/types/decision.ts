export interface Decision {
  id: string;

  // ── Core content ──────────────────────────────────────────────────────────
  /**
   * Short, scannable headline.
   * e.g. "Adopt REST API over GraphQL"
   * Optional for backward compat — absent on records from before this schema.
   */
  title?: string;
  /**
   * The full decision statement as a complete sentence or paragraph.
   * This is the canonical content field (required).
   */
  text: string;
  /**
   * 1–3 sentence summary of the decision and its implications.
   * Richer than `text` — provides executive-level context for briefings.
   */
  summary?: string;
  /**
   * Why this decision was made; the reasoning or driving constraint.
   * Only populated when it is explicitly stated in the source.
   */
  rationale?: string;
  /**
   * Options that were explicitly considered and rejected.
   * Only populated when alternatives are stated; empty array beats invented content.
   */
  alternatives?: string[];
  /**
   * Expected consequences, commitments, or follow-up actions implied by the decision.
   * Extracted explicitly from the source — not inferred.
   */
  consequences?: string[];

  // ── People ────────────────────────────────────────────────────────────────
  /** Primary decision-maker or announcing party. */
  decidedBy: string;
  decidedById?: string;
  /**
   * Other stakeholders explicitly named as affected, consulted, or impacted.
   * Distinct from decidedBy — these are people who need to know, not who decided.
   */
  stakeholders?: string[];

  // ── Classification ────────────────────────────────────────────────────────
  /** ISO date string of when the decision was made (YYYY-MM-DD). */
  date: string;
  /** Freeform context: meeting name, email subject, Slack channel, etc. */
  context: string;
  status: "active" | "superseded";
  /**
   * Where this decision originated.
   * Aligns with ActionItem.source so both can be filtered consistently.
   */
  source?: "meeting" | "slack" | "email" | "manual" | "chat";

  // ── Confidence & quality ──────────────────────────────────────────────────
  /**
   * 0–1 confidence this is a real finalized decision (not a proposal or discussion).
   * 1.0 = explicitly confirmed. 0.7–0.9 = strong signal. 0.45–0.69 = review band.
   * < 0.45 = not materialized.
   */
  confidence?: number;
  /**
   * Set to true when Basil extracted this decision but confidence falls in the
   * review band (0.45–0.69). The user must confirm or dismiss.
   *
   * Confirmed: set needsReview=false — decision promoted to fully verified.
   * Dismissed: delete the record.
   *
   * Briefings present needsReview decisions as "unconfirmed signals", not facts.
   */
  needsReview?: boolean;
  /** ISO timestamp when the user confirmed or dismissed the review flag. */
  reviewDismissedAt?: string;
  /** Free-form tags for filtering and search. */
  tags?: string[];

  // ── Linked objects ────────────────────────────────────────────────────────
  /**
   * IDs of ActionItems created as direct follow-ups to this decision.
   * Set when the decision is materialized alongside actions.
   */
  linkedActionIds?: string[];

  // ── Provenance ────────────────────────────────────────────────────────────
  createdAt: string;
  /**
   * Last-modification timestamp.
   * Absent on records created before domain unification — treat as equal to createdAt.
   */
  updatedAt?: string;
  /** ID of the BasilEvent that produced this decision (provenance). */
  eventId?: string;
  /**
   * Stable reference to the originating record in the source system
   * (e.g. "gmail:1abc2def", "slack:C01ABC:1234567890.123456").
   * Used as the primary dedup key — if two ingestion paths see the same sourceRef,
   * the second is silently dropped.
   */
  sourceRef?: string;
  /**
   * Additional source references when the same decision was detected in
   * multiple sources (e.g. same decision confirmed in email AND Slack thread).
   * The first detection wins; subsequent ones are appended here without
   * creating duplicate records.
   */
  additionalSourceRefs?: string[];
}

// No seeded content. Decisions only appear when Michael logs them or when
// Basil captures one from real verified activity. An empty list is honest;
// a fabricated list is not.
export const SEED_DECISIONS: Decision[] = [];
