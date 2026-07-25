export type ActionPriority = "high" | "medium" | "low";

/**
 * High-level category for grouping and routing actions.
 *
 * critical — role/project-critical work: strategic decisions, project deliverables,
 *            key stakeholder commitments, hires, approvals, technical reviews.
 * admin    — routine operational tasks: scheduling, confirmations, routine
 *            replies, expense reports, meeting logistics.
 * personal — non-work personal tasks: health, family, errands, personal finance.
 */
export type ActionCategory = "critical" | "admin" | "personal";

export interface ActionItem {
  id: string;
  text: string;
  owner: string;
  ownerId?: string;
  dueDate?: string;
  status: "open" | "done" | "overdue";
  /**
   * When set, this item reached "done" via an automatic lifecycle SWEEP, not a
   * real completion. Kept as status:"done" so every existing active/done filter
   * still treats it as terminal, but flagged so the Done list and completion
   * metrics don't conflate silently-expired work with genuinely-finished work.
   */
  archivedReason?: "stale-overdue" | "past-meeting" | "expired" | "rsvp-confirmed" | "reply-sent";
  source: "meeting" | "slack" | "teams" | "email" | "manual" | "chat" | "linear";
  createdAt: string;
  updatedAt: string;

  // ── Enrichment ───────────────────────────────────────────────────────────────
  /** Urgency level extracted from the source or set manually. */
  priority?: ActionPriority;
  /** 0–1 extraction confidence. Absent on manually created items. */
  confidence?: number;
  /** IDs of decisions this action is a direct consequence of. */
  linkedDecisionIds?: string[];
  /**
   * When Basil should surface this as a check-in (YYYY-MM-DD).
   * Distinct from dueDate — this is an internal reminder, not a deadline.
   */
  followUpDate?: string;
  /**
   * Timestamp of the most recent meaningful activity (status change, explicit
   * update, or reply). Used to detect stalled items. Defaults to createdAt.
   */
  lastActivityAt?: string;

  // ── Trust / review gate ──────────────────────────────────────────────────────
  /**
   * Set to true when Basil extracted this item but confidence falls in the
   * review band (0.35–0.59). The user must confirm or dismiss before it is
   * treated as a verified commitment.
   *
   * Confirmed: set needsReview=false (the item is promoted to normal).
   * Dismissed: delete the item entirely.
   *
   * Items with needsReview=true are excluded from briefings as facts;
   * the briefing marks them as "unconfirmed signals".
   */
  needsReview?: boolean;
  /** ISO timestamp when the user confirmed or dismissed the review flag. */
  reviewDismissedAt?: string;

  // ── Categorisation ───────────────────────────────────────────────────────────
  /**
   * High-level category: "critical" | "admin" | "personal".
   * Auto-classified on creation from rule-based patterns + LLM enrichment.
   * Absent on legacy items — treated as uncategorized in the UI.
   */
  category?: ActionCategory;
  /**
   * True when the action implies a pending decision that needs to be made
   * before it can be completed.  Detected heuristically and/or by LLM.
   * Click-through on this flag navigates to the Decisions page to log one.
   */
  decisionRequired?: boolean;
  /** ID of a decision the user created in response to the decisionRequired flag. */
  linkedDecisionId?: string;

  /**
   * ISO timestamp at which this action automatically expires and is silently
   * archived. Set by the AI when the source message contains time-relative
   * language that makes the action meaningless after a specific moment —
   * e.g. "can we change X before the meeting in 30 minutes" or "reply by EOD".
   * Once `expiresAt < now` the action is auto-archived in `listActions`.
   */
  expiresAt?: string;

  // ── Eisenhower classification ────────────────────────────────────────────────
  /**
   * Eisenhower Matrix quadrant — classified by AI from action text + context.
   *
   * Q1 — Urgent + Important      → Do first
   * Q2 — Not Urgent + Important  → Schedule
   * Q3 — Urgent + Not Important  → Delegate
   * Q4 — Not Urgent + Not Important → Eliminate
   */
  eisenhower?: "Q1" | "Q2" | "Q3" | "Q4";
  /** One-line AI rationale for the quadrant assignment (≤15 words). */
  eisenhowerReason?: string;
  /** ISO timestamp when the Eisenhower classification was last computed. */
  eisenhowerClassifiedAt?: string;

  // ── User annotations ────────────────────────────────────────────────────────
  /**
   * Freeform notes added by the user via "Explore further".
   * Never overwritten by AI pipeline runs — user-owned only.
   */
  notes?: string;

  // ── Provenance ───────────────────────────────────────────────────────────────
  /** ID of the BasilEvent that produced this item, if created via the event pipeline. */
  eventId?: string;
  /** Stable reference to the originating record in the source system (e.g. "gmail:1abc2def"). */
  sourceRef?: string;
  /** Additional source refs accumulated when the same action is seen from multiple sources. */
  additionalSourceRefs?: string[];
}

// No seeded content. Actions only appear when Michael adds them or when
// Basil captures one from real verified activity. An empty list is honest;
// a fabricated list is not.
export const SEED_ACTIONS: ActionItem[] = [];
