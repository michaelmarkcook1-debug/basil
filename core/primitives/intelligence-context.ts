/**
 * Primitive 7 — IntelligenceContext
 *
 * Scoped retrieval context assembled before any AI prompt is built.
 * Instead of each call site independently querying stores, the context
 * builder pre-fetches a structured snapshot relevant to the current signal
 * or generation task — and the AI call site consumes that snapshot.
 *
 * Benefits:
 *   - Consistent context across classification + materialization for the same signal
 *   - Auditable: the context fed to each AI call is persisted in the DispatchTrace
 *   - Scoped: only fetches what's relevant (no unbounded store reads in hot path)
 *   - Prevents context window bloat from over-fetching
 *
 * Assembly is gated on individual store availability:
 *   - recentSignals requires signalEvent_active
 *   - identityContext requires canonicalIdentity_active
 *   - rankedSignals requires ranking_active
 *
 * The context is assembled once per ingest event and passed to all AI calls
 * for that event, avoiding redundant Blob reads.
 */

import type { SignalEvent, SignalCategory } from "./signal-event";
import type { CanonicalIdentity } from "./canonical-identity";
import type { RankedSignal } from "./ranked-signal";

// ── Recent signal summary (lightweight, no full body) ─────────────────────────

export interface SignalSummary {
  id: string;
  sourceRef: string;
  title: string;
  category: SignalCategory;
  occurredAt: string;
  score?: number;         // from ranking, if available
  actionCount: number;
  decisionCount: number;
}

// ── IntelligenceContext ───────────────────────────────────────────────────────

export interface IntelligenceContext {
  /**
   * ISO8601 — when this context was assembled.
   * Used by the dispatcher to detect stale contexts (> 5 min old).
   */
  assembledAt: string;

  /**
   * The signal being processed, if context is signal-scoped.
   * null for generation tasks (briefing, digest, meeting prep).
   */
  currentSignal: SignalEvent | null;

  /**
   * Recent signals from the same source as currentSignal.
   * Sorted by occurredAt descending. Maximum 10 items.
   * Bodies excluded — title, category, and metadata only.
   */
  recentSignals: SignalSummary[];

  /**
   * Resolved identity for the sender of currentSignal.
   * null if identity unresolved or canonicalIdentity_active is false.
   */
  senderIdentity: CanonicalIdentity | null;

  /**
   * Top-ranked unresolved signals (no actions completed yet).
   * Maximum 5 items. Used to give AI context on what's already high-priority.
   */
  topRankedPending: RankedSignal[];

  /**
   * Count of unresolved actions across all signals.
   * Gives the AI a sense of current workload.
   */
  unresolvedActionCount: number;

  /**
   * Project names the current signal (or sender) is associated with.
   */
  projectContext: string[];

  /**
   * Token budget for this context when serialized into a prompt.
   * Assembler enforces this — context is trimmed if over budget.
   */
  tokenBudget: number;

  /**
   * Estimated token count of the assembled context.
   * Rough estimate: chars / 4.
   */
  estimatedTokens: number;
}

// ── Serializer ────────────────────────────────────────────────────────────────

/**
 * Serialize IntelligenceContext to a compact prompt-friendly string.
 * Called by AI call sites to inject context into the system or user prompt.
 *
 * Format: structured sections, no JSON blobs — optimized for LLM comprehension.
 */
export function serializeContext(ctx: IntelligenceContext): string {
  const parts: string[] = [];

  if (ctx.senderIdentity) {
    const id = ctx.senderIdentity;
    parts.push(
      `## Sender\n` +
      `Name: ${id.displayName}\n` +
      (id.company ? `Company: ${id.company}\n` : "") +
      (id.role ? `Role: ${id.role}\n` : "") +
      `Relationship strength: ${(id.relationshipStrength * 100).toFixed(0)}%\n` +
      `Direct interactions: ${id.directInteractionCount}`
    );
  }

  if (ctx.recentSignals.length > 0) {
    const lines = ctx.recentSignals.slice(0, 5).map((s) =>
      `- [${s.category}] ${s.title} (${s.occurredAt.slice(0, 10)})` +
      (s.actionCount > 0 ? ` — ${s.actionCount} action(s)` : "")
    );
    parts.push(`## Recent signals from same source\n${lines.join("\n")}`);
  }

  if (ctx.unresolvedActionCount > 0) {
    parts.push(`## Workload\n${ctx.unresolvedActionCount} unresolved action(s) currently tracked.`);
  }

  if (ctx.projectContext.length > 0) {
    parts.push(`## Projects\n${ctx.projectContext.join(", ")}`);
  }

  return parts.join("\n\n");
}
