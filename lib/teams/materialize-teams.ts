/**
 * Materializes Teams conversation intelligence into Basil's canonical stores:
 * Actions, Decisions, and Memory.
 *
 * Provenance on every created record:
 *   source    → "slack"  (closest match — ActionItem.source has no "teams" variant)
 *   sourceRef → "teams:<channelId>:<messageId>"
 *   eventId   → the BasilEvent that triggered this ingestion
 *
 * Idempotency: handled upstream — poll-ingest skips messages whose externalId
 * already exists in the events store, so this function is never called twice
 * for the same message/thread.
 */

import { createAction } from "@/lib/actions/store";
import { createDecision, linkActionToDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";
import { actionTier, decisionTier, memoryTier, needsReviewFlag } from "@/lib/trust/policy";
import type { SlackIntelligence, SlackSignalCategory } from "@/lib/teams/classify-teams";

// ── Input / output types ───────────────────────────────────────────────────────

export interface MaterializeTeamsInput {
  intelligence: SlackIntelligence;
  /** Full sourceRef: "teams:<channelId>:<messageId>" */
  sourceRef: string;
  /** BasilEvent ID created for this message. */
  eventId: string;
  /** Display channel name for context labels, e.g. "Teams: General" or "DM: Ed". */
  channelName: string;
  /** Author display name of the triggering message. */
  from: string;
  /** ISO date string of the message. */
  date: string;
}

export interface MaterializeTeamsResult {
  actionsCreated: number;
  decisionsCreated: number;
  memoriesCreated: number;
}

// ── Categories that generate actions ──────────────────────────────────────────

/** Categories that trigger action creation — including synthesized fallback when no explicit items found. */
const ACTION_CATEGORIES = new Set<SlackSignalCategory>([
  "action_assigned",
  "action_identified",
  "decision_needed",
  "blocker_raised",
  "escalation",
  "meeting_signal",
]);

/**
 * Categories that produce actions ONLY when the AI explicitly extracted them.
 * Never synthesize a fallback action for these — only honour explicit items.
 */
const EXPLICIT_ONLY_ACTION_CATEGORIES = new Set<SlackSignalCategory>([
  "relationship_signal",
]);

// ── Core materialization function ─────────────────────────────────────────────

/**
 * Write Teams intelligence outputs to Actions, Decisions, and Memory stores.
 *
 * Each store write is attempted independently — one failure never aborts others.
 * Errors are logged but never re-thrown.
 */
export async function materializeTeamsIntelligence(
  input: MaterializeTeamsInput
): Promise<MaterializeTeamsResult> {
  const { intelligence: intel, sourceRef, eventId, channelName, from, date } = input;
  const dateShort = date.slice(0, 10);
  const channelLabel = channelName.startsWith("Teams:")
    ? channelName
    : `#${channelName}`;

  let actionsCreated = 0;
  let decisionsCreated = 0;
  let memoriesCreated = 0;

  // ── Trust policy tier for this Teams message's confidence ─────────────────
  const aTier = actionTier(intel.confidence);
  const dTier = decisionTier(intel.confidence);

  // ── Actions ────────────────────────────────────────────────────────────────
  if (aTier !== "skip") {
    const isActionCategory = ACTION_CATEGORIES.has(intel.category);
    const isExplicitOnlyCategory = EXPLICIT_ONLY_ACTION_CATEGORIES.has(intel.category);

    if (intel.actions.length > 0 && (isActionCategory || isExplicitOnlyCategory)) {
      // Explicit extracted action items — honour for all qualifying category types
      for (const item of intel.actions) {
        if (!item.text?.trim()) continue;
        try {
          await createAction({
            text: item.text.trim(),
            owner: item.owner || "Michael Cook",
            dueDate: item.dueDate,
            source: "slack",
            eventId,
            sourceRef,
            priority: item.priority,
            confidence: intel.confidence,
            needsReview: needsReviewFlag(aTier),
          });
          actionsCreated++;
        } catch (e) {
          console.error("[teams-materialize] failed to create action:", e);
        }
      }
    } else if (intel.actions.length === 0 && isActionCategory) {
      // No explicit actions extracted — synthesize a canonical "check this" action
      // when Michael is specifically addressed or when the signal is high-stakes.
      // (Never synthesize for relationship_signal — only honour explicit items.)
      const actionText = synthesizeTeamsAction(
        intel.category,
        channelLabel,
        from,
        intel.isMichaelAddressed
      );
      if (actionText) {
        try {
          await createAction({
            text: actionText,
            owner: "Michael Cook",
            source: "slack",
            eventId,
            sourceRef,
            // Map Teams urgency to action priority for synthesized actions
            priority: intel.urgency === "high" ? "high" : intel.urgency === "medium" ? "medium" : "low",
            confidence: intel.confidence,
            needsReview: needsReviewFlag(aTier),
          });
          actionsCreated++;
        } catch (e) {
          console.error("[teams-materialize] failed to create synthesized action:", e);
        }
      }
    }
  }

  // ── Decisions ──────────────────────────────────────────────────────────────
  if (intel.category === "decision_made" && intel.decisions.length > 0 && dTier !== "skip") {
    for (const dec of intel.decisions) {
      if (!dec.text?.trim()) continue;
      try {
        const decision = await createDecision({
          text: dec.text.trim(),
          title: dec.title?.trim(),
          rationale: dec.rationale?.trim(),
          alternatives: dec.alternatives,
          consequences: dec.consequences,
          decidedBy: dec.decidedBy || from,
          // Named people in the thread are implicit stakeholders
          stakeholders: intel.people
            .map((p) => p.name)
            .filter((n) => n !== dec.decidedBy),
          date: dateShort,
          context: `From Teams ${channelLabel}`,
          source: "slack",
          confidence: intel.confidence,
          needsReview: needsReviewFlag(dTier),
          eventId,
          sourceRef,
        });
        decisionsCreated++;

        // Consequence actions inherit the same review flag as their parent decision.
        if (dec.consequences && dec.consequences.length > 0) {
          for (const consequence of dec.consequences) {
            if (!consequence.trim()) continue;
            try {
              const action = await createAction({
                text: consequence.trim(),
                owner: "Michael Cook",
                source: "slack",
                eventId,
                sourceRef,
                needsReview: needsReviewFlag(dTier),
                linkedDecisionIds: [decision.id],
              });
              await linkActionToDecision(decision.id, action.id);
              actionsCreated++;
            } catch {
              // Non-fatal
            }
          }
        }
      } catch (e) {
        console.error("[teams-materialize] failed to create decision:", e);
      }
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────────────
  // Persist key context for relationship signals, blockers, escalations, and
  // high-value informational updates that mention specific people or accounts.

  const memoryCandidates: Array<{ content: string; entity?: string }> = [];

  if (intel.keyContext.trim()) {
    const entity =
      intel.people.length > 0
        ? intel.people[0].name
        : intel.companies.length > 0
        ? intel.companies[0]
        : undefined;

    memoryCandidates.push({
      content: `[Teams ${channelLabel} — ${dateShort}] ${intel.keyContext.trim()}`,
      entity,
    });
  }

  // For relationship signals, add a brief per-person note (up to 3 people)
  if (intel.category === "relationship_signal" && intel.people.length > 0) {
    for (const person of intel.people.slice(0, 3)) {
      if (!person.name?.trim()) continue;
      const roleNote = person.role ? ` (${person.role})` : "";
      memoryCandidates.push({
        content: `[${dateShort}] ${person.name}${roleNote} mentioned in ${channelLabel} by ${from}.`,
        entity: person.name.trim(),
      });
    }
  }

  // For blockers and escalations, log each one so it surfaces in briefings
  if (
    (intel.category === "blocker_raised" || intel.category === "escalation") &&
    intel.blockers.length > 0
  ) {
    for (const blocker of intel.blockers.slice(0, 2)) {
      if (!blocker.trim()) continue;
      memoryCandidates.push({
        content: `[Blocker — ${dateShort}] ${blocker.trim()} (raised in Teams ${channelLabel})`,
      });
    }
  }

  const mTier = memoryTier(intel.confidence);
  for (const mem of memoryCandidates) {
    if (!mem.content.trim()) continue;
    if (mTier === "skip") continue;
    try {
      await createMemory({
        kind: "context",
        content: mem.content,
        entity: mem.entity,
        source: "inferred",
        confidence: intel.confidence,
        needsReview: needsReviewFlag(mTier),
        eventId,
        sourceRef,
      });
      memoriesCreated++;
    } catch (e) {
      console.error("[teams-materialize] failed to create memory:", e);
    }
  }

  return { actionsCreated, decisionsCreated, memoriesCreated };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Synthesize a fallback action text when the category implies one but
 * no explicit action items were found in the transcript.
 *
 * Only creates a synthesized action when Michael is addressed or when
 * the signal is unambiguously his to handle (blocker, escalation).
 */
function synthesizeTeamsAction(
  category: SlackSignalCategory,
  channelLabel: string,
  from: string,
  isMichaelAddressed: boolean
): string {
  switch (category) {
    case "action_assigned":
      return `Follow up on action from ${from} in ${channelLabel}`;
    case "action_identified":
      // Don't synthesize for identified-but-not-assigned unless Michael is named
      return isMichaelAddressed
        ? `Review action item from ${from} in ${channelLabel}`
        : "";
    case "decision_needed":
      return isMichaelAddressed
        ? `Provide decision requested by ${from} in ${channelLabel}`
        : "";
    case "blocker_raised":
      return `Unblock: ${from} flagged a blocker in ${channelLabel}`;
    case "escalation":
      return `Urgent: escalation from ${from} in ${channelLabel}`;
    case "meeting_signal":
      return isMichaelAddressed
        ? `Respond to scheduling request from ${from} in ${channelLabel}`
        : "";
    default:
      return "";
  }
}
