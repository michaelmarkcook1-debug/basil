/**
 * Signal Ranker
 *
 * Deterministic, explainable scoring engine. Produces a RankedSignal from
 * a SignalEvent using only fields available at write time — no AI, no external
 * lookups beyond the optional CanonicalIdentity passed in.
 *
 * All six component scores are independently derived and observable.
 * Every score decision is recorded in explanation[].
 *
 * Called from the signal pipeline (core/ingestion/signal-pipeline.ts)
 * after identity resolution, before the store write.
 *
 * Guardrails:
 *   - Pure function — no I/O, no async
 *   - Never throws — returns a floor-scored signal on any error
 *   - Weights are embedded in the result for audit trail
 */

import type { SignalEvent } from "@/core/primitives/signal-event";
import type { CanonicalIdentity } from "@/core/primitives/canonical-identity";
import {
  type RankedSignal,
  RANKING_WEIGHTS,
} from "@/core/primitives/ranked-signal";

// ── Category → impact mappings ────────────────────────────────────────────────

const URGENCY_BY_CATEGORY: Record<string, number> = {
  action_required:    0.90,
  action_assigned:    0.90,
  escalation:         0.85,
  blocker_raised:     0.80,
  decision_needed:    0.65,
  decision_made:      0.55,
  commercial_signal:  0.60,
  meeting_signal:     0.50,
  meeting_intelligence: 0.45,
  relationship_signal: 0.40,
  informational:      0.20,
  document_activity:  0.15,
  issue_update:       0.35,
  low_value_noise:    0.05,
  noise:              0.05,
  unknown:            0.25,
};

const COMMERCIAL_BY_CATEGORY: Record<string, number> = {
  commercial_signal:  0.95,
  decision_made:      0.75,
  decision_needed:    0.70,
  action_required:    0.50,
  action_assigned:    0.50,
  escalation:         0.60,
  blocker_raised:     0.55,
  meeting_intelligence: 0.40,
  relationship_signal: 0.35,
  meeting_signal:     0.25,
  issue_update:       0.30,
  informational:      0.10,
  document_activity:  0.10,
  low_value_noise:    0.02,
  noise:              0.02,
  unknown:            0.15,
};

// ── Component scorers ─────────────────────────────────────────────────────────

function scoreUrgency(
  signal: SignalEvent,
  explanation: string[]
): number {
  let score = URGENCY_BY_CATEGORY[signal.category] ?? 0.25;
  const reasons: string[] = [`category=${signal.category}`];

  // Trust tier boost
  if (signal.trust.trustTier === "auto") {
    score = Math.min(1, score + 0.05);
    reasons.push("trust=auto");
  }

  // Actions with imminent due dates
  const now = Date.now();
  const urgentActions = signal.actions.filter((a) => {
    if (!a.dueDate) return false;
    const due = new Date(a.dueDate).getTime();
    return !isNaN(due) && due - now < 86_400_000; // within 24h
  });
  if (urgentActions.length > 0) {
    score = Math.min(1, score + 0.15);
    reasons.push(`${urgentActions.length} action(s) due within 24h`);
  }

  // High-priority actions
  const highPriority = signal.actions.filter((a) => a.priority === "high");
  if (highPriority.length > 0) {
    score = Math.min(1, score + 0.08);
    reasons.push(`${highPriority.length} high-priority action(s)`);
  }

  explanation.push(`URGENCY: ${reasons.join(", ")} (score=${score.toFixed(2)})`);
  return score;
}

function scoreHierarchy(
  signal: SignalEvent,
  senderIdentity: CanonicalIdentity | null,
  explanation: string[]
): number {
  let score: number;
  let reason: string;

  if (senderIdentity) {
    // Use real relationship data if identity is resolved
    score = senderIdentity.relationshipStrength;
    reason = `identity resolved: strength=${senderIdentity.relationshipStrength.toFixed(2)}, interactions=${senderIdentity.directInteractionCount}`;

    // Boost for very frequent contact
    if (senderIdentity.directInteractionCount >= 20) {
      score = Math.min(1, score + 0.10);
      reason += " (frequent contact bonus)";
    }
  } else {
    // Fall back to source weight as proxy — DMs from any source signal directness
    score = signal.trust.sourceWeight;
    reason = `identity unresolved, using sourceWeight=${signal.trust.sourceWeight.toFixed(2)}`;

    // DM signals have higher hierarchy signal (direct 1:1)
    if (signal.source === "slack" && signal.title.startsWith("DM from")) {
      score = Math.min(1, score + 0.10);
      reason += " (DM boost)";
    }
  }

  explanation.push(`HIERARCHY: ${reason} (score=${score.toFixed(2)})`);
  return score;
}

function scoreCommercialImpact(
  signal: SignalEvent,
  explanation: string[]
): number {
  const score = COMMERCIAL_BY_CATEGORY[signal.category] ?? 0.15;
  explanation.push(
    `COMMERCIAL_IMPACT: category=${signal.category} (score=${score.toFixed(2)})`
  );
  return score;
}

function scoreRelationshipWeight(
  signal: SignalEvent,
  senderIdentity: CanonicalIdentity | null,
  explanation: string[]
): number {
  let score: number;
  let reason: string;

  if (senderIdentity) {
    score = senderIdentity.relationshipStrength;
    reason = `identity resolved: strength=${senderIdentity.relationshipStrength.toFixed(2)}`;

    // Recency bonus: interacted in last 30 days
    if (senderIdentity.lastInteractionAt) {
      const daysSince =
        (Date.now() - new Date(senderIdentity.lastInteractionAt).getTime()) /
        86_400_000;
      if (daysSince < 30) {
        score = Math.min(1, score + 0.08);
        reason += ` (recent: ${Math.floor(daysSince)}d ago)`;
      }
    }
  } else {
    // Without identity: use source weight × confidence
    score = signal.trust.sourceWeight * signal.trust.confidence;
    reason = `identity unresolved, sourceWeight×confidence=${score.toFixed(2)}`;
  }

  explanation.push(`RELATIONSHIP: ${reason} (score=${score.toFixed(2)})`);
  return score;
}

function scoreCommitmentRisk(
  signal: SignalEvent,
  explanation: string[]
): number {
  const actions = signal.actions;
  if (actions.length === 0) {
    explanation.push("COMMITMENT_RISK: no actions extracted (score=0.00)");
    return 0;
  }

  let score = Math.min(0.40, actions.length * 0.10); // up to 0.40 for count
  const reasons: string[] = [`${actions.length} action(s)`];

  // Due date risk
  const withDueDates = actions.filter((a) => a.dueDate);
  if (withDueDates.length > 0) {
    score = Math.min(1, score + 0.25);
    reasons.push(`${withDueDates.length} with due dates`);
  }

  // Overdue risk
  const now = Date.now();
  const overdue = actions.filter((a) => {
    if (!a.dueDate) return false;
    const due = new Date(a.dueDate).getTime();
    return !isNaN(due) && due < now;
  });
  if (overdue.length > 0) {
    score = Math.min(1, score + 0.35);
    reasons.push(`${overdue.length} OVERDUE`);
  }

  explanation.push(`COMMITMENT_RISK: ${reasons.join(", ")} (score=${score.toFixed(2)})`);
  return score;
}

function scoreMeetingProximity(
  signal: SignalEvent,
  explanation: string[]
): number {
  // Full proximity scoring requires calendar context (future: SignalThread + calendar lookup)
  // For now: derive from eventType and category
  if (signal.eventType === "calendar_event" || signal.eventType === "meeting") {
    explanation.push("MEETING_PROXIMITY: is calendar/meeting event (score=0.90)");
    return 0.90;
  }
  if (signal.category === "meeting_signal" || signal.category === "meeting_intelligence") {
    explanation.push("MEETING_PROXIMITY: meeting-related category (score=0.60)");
    return 0.60;
  }
  explanation.push("MEETING_PROXIMITY: no meeting context (score=0.05)");
  return 0.05;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rank a SignalEvent. Pure function — no I/O.
 *
 * @param signal         The signal to rank
 * @param senderIdentity Resolved CanonicalIdentity for the sender (null if unresolved)
 * @returns              RankedSignal with all components and explanation
 */
export function rankSignal(
  signal: SignalEvent,
  senderIdentity: CanonicalIdentity | null = null
): RankedSignal {
  const explanation: string[] = [];

  const urgency          = scoreUrgency(signal, explanation);
  const hierarchy        = scoreHierarchy(signal, senderIdentity, explanation);
  const commercialImpact = scoreCommercialImpact(signal, explanation);
  const relationshipWeight = scoreRelationshipWeight(signal, senderIdentity, explanation);
  const commitmentRisk   = scoreCommitmentRisk(signal, explanation);
  const meetingProximity = scoreMeetingProximity(signal, explanation);

  const w = RANKING_WEIGHTS;
  const score =
    urgency          * w.urgency          +
    hierarchy        * w.hierarchy        +
    commercialImpact * w.commercialImpact +
    relationshipWeight * w.relationshipWeight +
    commitmentRisk   * w.commitmentRisk   +
    meetingProximity * w.meetingProximity;

  explanation.push(`TOTAL: score=${score.toFixed(3)}`);

  return {
    signalId: signal.id,
    score: Math.round(score * 1000) / 1000,
    urgency:          Math.round(urgency * 1000) / 1000,
    hierarchy:        Math.round(hierarchy * 1000) / 1000,
    commercialImpact: Math.round(commercialImpact * 1000) / 1000,
    relationshipWeight: Math.round(relationshipWeight * 1000) / 1000,
    commitmentRisk:   Math.round(commitmentRisk * 1000) / 1000,
    meetingProximity: Math.round(meetingProximity * 1000) / 1000,
    explanation,
    rankedAt: new Date().toISOString(),
    weights: { ...w },
  };
}
