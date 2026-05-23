/**
 * Intelligence Context Builder
 *
 * Assembles an IntelligenceContext for a signal or generation task by
 * reading from available primitive stores. Gracefully degrades when
 * stores are empty or flags are disabled.
 *
 * Context assembly is non-blocking and fault-tolerant: if any store read
 * fails, that section is omitted rather than aborting the AI call.
 *
 * Token budget enforcement:
 *   Default: 800 tokens (~3200 chars) — leaves room for the main prompt
 *   If over budget: recentSignals is trimmed first, then topRankedPending
 *
 * Gating:
 *   recentSignals    → requires signalEvent_active
 *   senderIdentity   → requires canonicalIdentity_active
 *   topRankedPending → requires ranking_active
 */

import type { SignalEvent } from "@/core/primitives/signal-event";
import type { FeatureFlags } from "@/core/feature-flags";
import type {
  IntelligenceContext,
  SignalSummary,
} from "@/core/primitives/intelligence-context";
import { readSignalEvents } from "@/core/storage/signal-event-store";
import { resolveIdentity } from "@/core/storage/canonical-identity-store";
import { listActions } from "@/lib/actions/store";

const DEFAULT_TOKEN_BUDGET = 800;

// ── Signal summary ────────────────────────────────────────────────────────────

function toSummary(s: SignalEvent): SignalSummary {
  return {
    id: s.id,
    sourceRef: s.sourceRef,
    title: s.title,
    category: s.category,
    occurredAt: s.occurredAt,
    score: s.ranking?.score,
    actionCount: s.actions.length,
    decisionCount: s.decisions.length,
  };
}

// ── Token estimate ────────────────────────────────────────────────────────────

function estimateTokens(ctx: Partial<IntelligenceContext>): number {
  let chars = 0;
  if (ctx.senderIdentity) {
    chars += JSON.stringify(ctx.senderIdentity).length;
  }
  if (ctx.recentSignals) {
    chars += JSON.stringify(ctx.recentSignals).length;
  }
  if (ctx.topRankedPending) {
    chars += JSON.stringify(ctx.topRankedPending).length;
  }
  return Math.ceil(chars / 4);
}

// ── Builder ───────────────────────────────────────────────────────────────────

export interface BuildContextOpts {
  username: string;
  /** Signal being processed. null for generation tasks. */
  currentSignal: SignalEvent | null;
  flags: FeatureFlags;
  tokenBudget?: number;
}

/**
 * Assemble an IntelligenceContext for an AI call.
 * All store reads are gated on feature flags and fail gracefully.
 */
export async function buildIntelligenceContext(
  opts: BuildContextOpts
): Promise<IntelligenceContext> {
  const {
    username,
    currentSignal,
    flags,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
  } = opts;

  const assembledAt = new Date().toISOString();

  // ── Sender identity ───────────────────────────────────────────────────────
  let senderIdentity = null;
  if (flags.canonicalIdentity_active && currentSignal) {
    const sender = currentSignal.participants.find((p) => p.role === "sender");
    if (sender) {
      try {
        senderIdentity = await resolveIdentity(
          username,
          sender.rawEmail,
          sender.rawName
        );
      } catch {
        // Graceful degradation — identity not available
      }
    }
  }

  // ── Recent signals from same source ──────────────────────────────────────
  let recentSignals: SignalSummary[] = [];
  if (flags.signalEvent_active && currentSignal) {
    try {
      const signals = await readSignalEvents(username, {
        source: currentSignal.source,
        limit: 10,
      });
      recentSignals = signals
        .filter((s) => s.id !== currentSignal.id)
        .slice(0, 8)
        .map(toSummary);
    } catch {
      // Graceful degradation
    }
  }

  // ── Top ranked pending ────────────────────────────────────────────────────
  let topRankedPending: IntelligenceContext["topRankedPending"] = [];
  if (flags.ranking_active && flags.signalEvent_active) {
    try {
      const signals = await readSignalEvents(username, { limit: 100 });
      topRankedPending = signals
        .filter((s) => s.ranking && s.actionIds.length > 0)
        .sort((a, b) => (b.ranking!.score - a.ranking!.score))
        .slice(0, 5)
        .map((s) => s.ranking!);
    } catch {
      // Graceful degradation
    }
  }

  // ── Unresolved action count ───────────────────────────────────────────────
  let unresolvedActionCount = 0;
  try {
    const actions = await listActions(username);
    unresolvedActionCount = actions.filter(
      (a: { status?: string }) => a.status !== "completed" && a.status !== "dismissed"
    ).length;
  } catch {
    // Graceful degradation
  }

  // ── Project context ───────────────────────────────────────────────────────
  const projectContext = currentSignal?.projects ?? [];

  // ── Token budget enforcement ──────────────────────────────────────────────
  const ctx: IntelligenceContext = {
    assembledAt,
    currentSignal,
    recentSignals,
    senderIdentity,
    topRankedPending,
    unresolvedActionCount,
    projectContext,
    tokenBudget,
    estimatedTokens: 0,
  };

  ctx.estimatedTokens = estimateTokens(ctx);

  // Trim if over budget: recentSignals first, then topRankedPending
  while (ctx.estimatedTokens > tokenBudget && ctx.recentSignals.length > 0) {
    ctx.recentSignals = ctx.recentSignals.slice(0, -1);
    ctx.estimatedTokens = estimateTokens(ctx);
  }
  while (ctx.estimatedTokens > tokenBudget && ctx.topRankedPending.length > 0) {
    ctx.topRankedPending = ctx.topRankedPending.slice(0, -1);
    ctx.estimatedTokens = estimateTokens(ctx);
  }

  return ctx;
}
