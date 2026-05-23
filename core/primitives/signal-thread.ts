/**
 * Primitive 4 — SignalThread
 *
 * Groups related SignalEvents into a coherent conversation thread.
 * A thread is the unit of context — all signals in a thread share a
 * common topic and should be ranked and surfaced together.
 *
 * Examples:
 *   - Gmail: all emails with the same threadId
 *   - Slack: all messages with the same messageTs root
 *   - Mixed: a Slack thread that spawned a follow-up email chain
 *
 * Thread building is gated on signalThread_active feature flag.
 * When active, every new SignalEvent triggers a thread upsert.
 *
 * Storage: "sage-signal-threads.json" per user
 *
 * Thread lifecycle:
 *   open      — active conversation, new signals expected
 *   stale     — no new signals in > 7 days, may be auto-closed
 *   closed    — conversation concluded, or manually resolved
 */

import type { SignalSource, SignalCategory } from "./signal-event";
import type { TrustTier } from "./trust-envelope";

// ── Thread status ─────────────────────────────────────────────────────────────

export type SignalThreadStatus = "open" | "stale" | "closed";

// ── SignalThread ──────────────────────────────────────────────────────────────

export interface SignalThread {
  /**
   * Stable thread ID — sha256 of (source + threadKey), hex 16 chars.
   * Survives re-ingest of the same thread.
   */
  id: string;

  /**
   * The stable external thread identifier from the source system.
   * Gmail: threadId   Slack: root messageTs   Linear: issue id
   */
  threadKey: string;

  /**
   * Primary source system for this thread.
   * Cross-source threads (Slack + email) use the source of the first signal.
   */
  primarySource: SignalSource;

  /**
   * All sources that have contributed signals to this thread.
   */
  sources: SignalSource[];

  /**
   * Thread title — derived from the first or most representative signal.
   */
  title: string;

  /**
   * Semantic category of the thread — the most common category among
   * its signals, or the highest-priority one.
   */
  category: SignalCategory;

  /**
   * Highest trust tier among all signals in this thread.
   * A thread with any "auto" signal is itself "auto".
   */
  trustTier: TrustTier;

  // ── Participants ────────────────────────────────────────────────────────────

  /**
   * Canonical identity IDs of everyone who participated in this thread.
   * Populated as signals are added and CanonicalIdentity is resolved.
   */
  participantIds: string[];

  /**
   * Raw participant names/emails (before CanonicalIdentity resolution).
   */
  rawParticipants: string[];

  // ── Signal membership ───────────────────────────────────────────────────────

  /**
   * IDs of all SignalEvents that belong to this thread, ordered by occurredAt.
   */
  signalIds: string[];

  /** Total number of signals in this thread. */
  signalCount: number;

  // ── Timing ──────────────────────────────────────────────────────────────────

  /** ISO8601 — when the first signal in this thread occurred. */
  firstSignalAt: string;

  /** ISO8601 — when the most recent signal in this thread occurred. */
  lastSignalAt: string;

  /** ISO8601 — when Basil first created this thread record. */
  createdAt: string;

  /** ISO8601 — when this thread record was last updated. */
  updatedAt: string;

  // ── Status ──────────────────────────────────────────────────────────────────

  status: SignalThreadStatus;

  /**
   * ISO8601 — when the status was last changed.
   * null if never manually changed (auto-derived from lastSignalAt).
   */
  statusChangedAt?: string;

  // ── Derived intelligence ─────────────────────────────────────────────────────

  /**
   * IDs of Action records spawned from signals in this thread.
   * Union of all signal.actionIds.
   */
  actionIds: string[];

  /**
   * IDs of Decision records spawned from signals in this thread.
   */
  decisionIds: string[];

  /**
   * Project tags associated with this thread — union across all signals.
   */
  projects: string[];
}

// ── Builder helpers ───────────────────────────────────────────────────────────

/**
 * Create a new SignalThread from the first signal in a thread.
 * Does not write to storage — caller is responsible for persistence.
 */
export function buildSignalThread(opts: {
  id: string;
  threadKey: string;
  primarySource: SignalSource;
  title: string;
  category: SignalCategory;
  trustTier: TrustTier;
  firstSignalId: string;
  firstSignalAt: string;
  rawParticipants: string[];
  actionIds?: string[];
  decisionIds?: string[];
  projects?: string[];
}): SignalThread {
  const now = new Date().toISOString();
  return {
    id: opts.id,
    threadKey: opts.threadKey,
    primarySource: opts.primarySource,
    sources: [opts.primarySource],
    title: opts.title,
    category: opts.category,
    trustTier: opts.trustTier,
    participantIds: [],
    rawParticipants: opts.rawParticipants,
    signalIds: [opts.firstSignalId],
    signalCount: 1,
    firstSignalAt: opts.firstSignalAt,
    lastSignalAt: opts.firstSignalAt,
    createdAt: now,
    updatedAt: now,
    status: "open",
    actionIds: opts.actionIds ?? [],
    decisionIds: opts.decisionIds ?? [],
    projects: opts.projects ?? [],
  };
}

/**
 * Merge a new signal into an existing thread.
 * Returns the updated thread — caller is responsible for persistence.
 */
export function addSignalToThread(
  thread: SignalThread,
  signal: {
    id: string;
    occurredAt: string;
    source: SignalSource;
    category: SignalCategory;
    trustTier: TrustTier;
    rawParticipants: string[];
    actionIds: string[];
    decisionIds: string[];
    projects: string[];
  }
): SignalThread {
  const now = new Date().toISOString();

  // Merge sources
  const sources = thread.sources.includes(signal.source)
    ? thread.sources
    : [...thread.sources, signal.source];

  // Escalate trust tier (auto > review > blocked)
  const tierRank = { auto: 2, review: 1, blocked: 0 } as const;
  const trustTier: TrustTier =
    tierRank[signal.trustTier] > tierRank[thread.trustTier]
      ? signal.trustTier
      : thread.trustTier;

  // Merge raw participants (dedup)
  const rawParticipants = [
    ...new Set([...thread.rawParticipants, ...signal.rawParticipants]),
  ];

  // Merge derived IDs (dedup)
  const actionIds = [...new Set([...thread.actionIds, ...signal.actionIds])];
  const decisionIds = [
    ...new Set([...thread.decisionIds, ...signal.decisionIds]),
  ];
  const projects = [...new Set([...thread.projects, ...signal.projects])];

  // Update lastSignalAt if newer
  const lastSignalAt =
    signal.occurredAt > thread.lastSignalAt
      ? signal.occurredAt
      : thread.lastSignalAt;

  return {
    ...thread,
    sources,
    trustTier,
    rawParticipants,
    signalIds: [...thread.signalIds, signal.id],
    signalCount: thread.signalCount + 1,
    lastSignalAt,
    updatedAt: now,
    status: "open",  // re-open stale threads when a new signal arrives
    actionIds,
    decisionIds,
    projects,
  };
}
