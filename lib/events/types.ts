// Basil event model: anything that might deserve Michael's attention — an email,
// a Slack message, a calendar change. Each event gets classified by the rules
// engine into one of three dispositions (auto / draft / notify) and flows
// through a single queue that drives the dashboard widget + approval panel.

export type EventSource = "email" | "slack" | "calendar" | "drive" | "manual" | "zoom_email";

export type EventDisposition =
  | "auto" // Basil acted — no user attention required, just a record
  | "draft" // Basil prepared a response, awaits approval
  | "notify"; // High-signal heads-up — no action queued, just surface it

export type EventStatus =
  | "pending"      // awaiting user approval
  | "executing"    // executor is running (transient — should resolve quickly)
  | "executed"     // action completed successfully
  | "failed"       // execution attempted but failed — see executionError
  | "rejected"     // user declined
  | "acknowledged" // notify events the user has seen
  | "approved";    // kept for backward compat with stored events that predate the executor

export type EventPriority = "high" | "normal" | "low";

/**
 * What the executor does when this event is approved.
 * Derived automatically from draft.channel if not set explicitly.
 *
 * send_email       — sends the draft via Gmail (requires draft.channel === "email")
 * send_slack       — sends the draft via Slack (requires draft.channel === "slack")
 * create_action    — writes a new ActionItem from draft.body / headline
 * create_decision  — writes a new Decision from draft.body / headline
 * create_memory    — writes a new Memory fact from draft.body / headline
 * acknowledge      — no external action; just marks the event seen (notify-only)
 */
export type EventActionType =
  | "send_email"
  | "send_slack"
  | "create_action"
  | "create_decision"
  | "create_memory"
  | "acknowledge";

export interface BasilEvent {
  id: string;

  // ── Source identification ─────────────────────────────────────────────────
  /** Stable reference to the originating record in the source system
   *  (Gmail message id, Slack ts+channelId, Calendar event id, etc.).
   *  Canonical field — use this in new code.
   *  Used to dedupe so re-polling never creates duplicate Basil events. */
  sourceRef?: string;
  /** Backward-compatible alias for sourceRef. Legacy stored events may have
   *  this set instead of (or in addition to) sourceRef. */
  externalId?: string;
  source: EventSource;
  /** Raw payload captured from the source at ingest time.
   *  Preserved for debugging and future reprocessing without re-fetching. */
  payload?: Record<string, unknown>;

  // ── Content ───────────────────────────────────────────────────────────────
  /** Short headline Basil would say out loud: "New email from Malcolm about AG v1" */
  headline: string;
  /** Full context Basil used to decide — shown verbatim in the approval card. */
  context: string;
  /** If set, Basil prepared a draft response awaiting approval. */
  draft?: {
    channel: "email" | "slack";
    to: string;
    subject?: string;
    /** The draft body.  Empty string means AI generation is still pending. */
    body: string;
    /** ISO timestamp when the AI generated this body.  Absent → placeholder / not yet generated. */
    generatedAt?: string;
    /** Human-readable caveat shown in the UI when context was insufficient for a confident draft. */
    caveat?: string;
  };

  // ── Classification ────────────────────────────────────────────────────────
  /** Person this event is about — used for avatar + relationship updates. */
  entityName?: string;
  disposition: EventDisposition;
  priority: EventPriority;
  status: EventStatus;
  /** Explicit action the executor should take on approval.
   *  Derived automatically from draft.channel when absent. */
  actionType?: EventActionType;
  /** Reasoning Basil used, shown in the "why" section of the approval card. */
  rationale: string;
  /** 0–1 confidence in this classification.
   *  1.0 = definitive rule match (keyword hit, explicit DM).
   *  < 1.0 = heuristic (key-person proximity, catch-all auto). */
  confidence?: number;
  createdAt: string;
  updatedAt: string;
  /** Free-form tags — "money", "legal", "hiring", "decision", "action", etc. */
  tags: string[];

  // ── Linked objects ────────────────────────────────────────────────────────
  /** ID of the ActionItem created when this event was executed. */
  actionId?: string;
  /** ID of the Decision created when this event was executed. */
  decisionId?: string;
  /** ID of the Memory created when this event was executed. */
  memoryId?: string;
  /** ID of a related contact (set by contact-tracking features). */
  contactId?: string;

  // ── Execution metadata ────────────────────────────────────────────────────
  /** ISO timestamp when execution was attempted. */
  executedAt?: string;
  /** Human-readable summary of what was done, e.g. "Email sent to malcolm@acme.com". */
  executionResult?: string;
  /** Reason for failure when status === "failed". */
  executionError?: string;
  /** Generic ID of the created/sent artifact — kept for backward compat.
   *  Prefer actionId / decisionId / memoryId for typed access. */
  createdObjectId?: string;
}

export interface IngestPayload {
  source: EventSource;
  /** Stable external id. If present, ingest will dedupe against previously-seen events. */
  externalId?: string;
  /** Title / subject. */
  title: string;
  /** Body / message text. */
  body: string;
  from?: string;
  /** Raw email address of the sender (e.g. "tom@example.com").
   *  Used as draft.to so Gmail gets a valid address, not a display name. */
  fromEmail?: string;
  channel?: string;
  /**
   * ISO timestamp of the originating message — email send time, Slack message ts,
   * calendar event start, etc.  Used so extracted actions/decisions/memories are
   * dated to the source event rather than the ingest time.
   * Defaults to ingest time if not provided.
   */
  date?: string;
  /** Extra hints the rules engine can use. */
  hints?: {
    isDM?: boolean;
    isGroupDM?: boolean;
    isMention?: boolean;
    isFromKeyPerson?: boolean;
  };
}
