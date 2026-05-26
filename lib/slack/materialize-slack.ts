/**
 * Materializes Slack conversation intelligence into Basil's canonical stores:
 * Actions, Decisions, and Memory.
 *
 * Provenance on every created record:
 *   source    → "slack"
 *   sourceRef → "slack:<channelId>:<messageTs>"
 *   eventId   → the BasilEvent that triggered this ingestion
 *
 * Idempotency: handled upstream — poll-ingest skips messages whose externalId
 * already exists in the events store, so this function is never called twice
 * for the same message/thread.
 */

import { createActionTracked } from "@/lib/actions/store";
import { createDecisionTracked, linkActionToDecision } from "@/lib/decisions/store";
import { createMemoryTracked } from "@/lib/memory/store";
import { actionTier, decisionTier, memoryTier, needsReviewFlag } from "@/lib/trust/policy";
import {
  auditCreated,
  auditUpdated,
  auditFailed,
  type AuditEntry,
} from "@/lib/ingest/audit-log";
import type { SlackIntelligence, SlackSignalCategory } from "./classify-slack";
import { getSelfIdentity } from "@/lib/self-identity";

// ── Input / output types ───────────────────────────────────────────────────────

export interface MaterializeSlackInput {
  /** Username to scope memory writes to. Required — no fallback. */
  username: string;
  intelligence: SlackIntelligence;
  /** Full sourceRef: "slack:<channelId>:<messageTs>" */
  sourceRef: string;
  /** BasilEvent ID created for this message. */
  eventId: string;
  /** Display channel name for context labels, e.g. "#eng-team" or "DM: Ed". */
  channelName: string;
  /** Author display name of the triggering message. */
  from: string;
  /** ISO date string of the message. */
  date: string;
  /**
   * True when this message is a Direct Message or Group DM.
   * Used to relax the isMichaelAddressed requirement — in a DM the
   * conversation is inherently between Michael and the other party.
   */
  isDM?: boolean;
}

export interface MaterializeSlackResult {
  actionsCreated: number;
  decisionsCreated: number;
  memoriesCreated: number;
  /** Audit entries for every item outcome — ready to pass to appendAuditEntries. */
  auditEntries: AuditEntry[];
}

// ── Categories that generate actions ──────────────────────────────────────────

/**
 * Categories that trigger action creation when Michael is specifically addressed
 * OR when the category is inherently direct (action_assigned, blocker, escalation).
 */
const ACTION_CATEGORIES = new Set<SlackSignalCategory>([
  "action_assigned",
  "blocker_raised",
  "escalation",
  "decision_needed",
  "meeting_signal",
]);

/**
 * Categories that produce actions ONLY when the AI explicitly extracted them
 * AND Michael is addressed. Never synthesize a fallback for these.
 *
 * action_identified is here because the action may belong to someone else in the
 * thread — only create it when Michael was specifically named/mentioned.
 */
const EXPLICIT_ONLY_ACTION_CATEGORIES = new Set<SlackSignalCategory>([
  "relationship_signal",
  "action_identified",  // moved from ACTION_CATEGORIES — requires isMichaelAddressed check
]);

/**
 * Returns true if the action's owner field clearly refers to the current user (self).
 * Blank/omitted owner is treated as "possibly self" (included).
 * An owner that is clearly someone else → excluded.
 */
function isOwnerSelfOrUnknown(owner: string | undefined, selfNames: string[]): boolean {
  if (!owner || !owner.trim()) return true; // unset → include (ambiguous)
  const o = owner.trim().toLowerCase();
  // Accept first-person references
  if (o === "me" || o === "i") return true;
  // Accept if owner matches any of the user's known names
  if (selfNames.some((n) => o.includes(n) || n.includes(o))) return true;
  // Reject channel/team references (#dev-team, @team, "the team", "everyone", etc.)
  if (o.startsWith("#") || o.startsWith("@") || o.includes(" team") || o === "everyone" || o === "all") return false;
  // Any other named person → not self
  return false;
}

// ── Core materialization function ─────────────────────────────────────────────

/**
 * Write Slack intelligence outputs to Actions, Decisions, and Memory stores.
 *
 * Each store write is attempted independently — one failure never aborts others.
 * Errors are logged but never re-thrown.
 */
export async function materializeSlackIntelligence(
  input: MaterializeSlackInput
): Promise<MaterializeSlackResult> {
  const { intelligence: intel, sourceRef, eventId, channelName, from, date, username, isDM = false } = input;

  if (!username) {
    console.error("[slack-materialize] username is required — refusing to write without owner", { sourceRef });
    return { actionsCreated: 0, decisionsCreated: 0, memoriesCreated: 0, auditEntries: [] };
  }

  const selfIdentity = await getSelfIdentity(username).catch(() => ({ emails: [], names: [] }));

  const dateShort = date.slice(0, 10);
  const channelLabel = channelName.startsWith("#") || channelName.startsWith("DM")
    ? channelName
    : `#${channelName}`;

  let actionsCreated = 0;
  let decisionsCreated = 0;
  let memoriesCreated = 0;
  const auditEntries: AuditEntry[] = [];

  // ── Trust policy tier for this Slack message's confidence ─────────────────
  const aTier = actionTier(intel.confidence);
  const dTier = decisionTier(intel.confidence);

  // ── Actions ────────────────────────────────────────────────────────────────
  if (aTier !== "skip") {
    const isActionCategory = ACTION_CATEGORIES.has(intel.category);
    const isExplicitOnlyCategory = EXPLICIT_ONLY_ACTION_CATEGORIES.has(intel.category);

    if (intel.actions.length > 0 && (isActionCategory || isExplicitOnlyCategory)) {
      // Explicit extracted action items — only create actions owned by (or assignable to) Michael.
      //
      // Filter rules (in priority order):
      //   1. Skip if owner is clearly someone other than Michael (e.g. "Christopher Walton")
      //   2. For action_identified: also skip if Michael wasn't specifically addressed —
      //      channel broadcasts where "someone" needs to do something shouldn't become
      //      Michael's actions unless he was named.
      //   3. For all other categories: include when owner is blank/Michael.
      for (const item of intel.actions) {
        if (!item.text?.trim()) continue;

        // Skip actions that belong to a named person who isn't the current user
        if (!isOwnerSelfOrUnknown(item.owner, selfIdentity.names)) {
          console.log(
            `[slack-materialize] skipping action owned by "${item.owner}" (not self): "${item.text.slice(0, 60)}"`
          );
          continue;
        }

        // Blank-owner actions in channel messages (not DMs) are channel broadcasts —
        // "someone needs to do X" does NOT mean Michael. Only include when Michael
        // was explicitly addressed or it is his own DM/group-DM conversation.
        if (!item.owner?.trim() && !isDM && !intel.isMichaelAddressed) {
          console.log(
            `[slack-materialize] skipping blank-owner action in channel (Michael not addressed): "${item.text.slice(0, 60)}"`
          );
          continue;
        }

        // For action_identified: only include if Michael was explicitly addressed
        if (intel.category === "action_identified" && !isDM && !intel.isMichaelAddressed) {
          console.log(
            `[slack-materialize] skipping action_identified (Michael not addressed): "${item.text.slice(0, 60)}"`
          );
          continue;
        }

        try {
          const { item: action, created } = await createActionTracked(username, {
            text: item.text.trim(),
            owner: item.owner,
            dueDate: item.dueDate,
            source: "slack",
            eventId,
            sourceRef,
            priority: item.priority,
            confidence: intel.confidence,
            needsReview: needsReviewFlag(aTier),
          });
          if (created) {
            actionsCreated++;
            auditEntries.push(auditCreated(sourceRef, "action", action.id, item.text.trim().slice(0, 80)));
          } else {
            auditEntries.push(auditUpdated(sourceRef, "action", action.id, item.text.trim().slice(0, 80)));
          }
        } catch (e) {
          console.error("[slack-materialize] failed to create action:", e);
          auditEntries.push(auditFailed(sourceRef, "action", e instanceof Error ? e.message : String(e)));
        }
      }
    } else if (intel.actions.length === 0 && isActionCategory) {
      // No explicit actions extracted — synthesize a canonical "check this" action
      // when Michael is specifically addressed or when the signal is high-stakes.
      // (Never synthesize for relationship_signal — only honour explicit items.)
      const actionText = synthesizeSlackAction(
        intel.category,
        channelLabel,
        from,
        intel.isMichaelAddressed,
        isDM
      );
      if (actionText) {
        try {
          const { item: action, created } = await createActionTracked(username, {
            text: actionText,
            source: "slack",
            eventId,
            sourceRef,
            // Map Slack urgency to action priority for synthesized actions
            priority: intel.urgency === "high" ? "high" : intel.urgency === "medium" ? "medium" : "low",
            confidence: intel.confidence,
            needsReview: needsReviewFlag(aTier),
          });
          if (created) {
            actionsCreated++;
            auditEntries.push(auditCreated(sourceRef, "action", action.id, actionText.slice(0, 80)));
          } else {
            auditEntries.push(auditUpdated(sourceRef, "action", action.id, actionText.slice(0, 80)));
          }
        } catch (e) {
          console.error("[slack-materialize] failed to create synthesized action:", e);
          auditEntries.push(auditFailed(sourceRef, "action", e instanceof Error ? e.message : String(e)));
        }
      }
    }
  }

  // ── Decisions ──────────────────────────────────────────────────────────────
  if (intel.category === "decision_made" && intel.decisions.length > 0 && dTier !== "skip") {
    for (const dec of intel.decisions) {
      if (!dec.text?.trim()) continue;
      try {
        const { item: decision, created: decCreated } = await createDecisionTracked(username, {
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
          context: `From Slack ${channelLabel}`,
          source: "slack",
          confidence: intel.confidence,
          needsReview: needsReviewFlag(dTier),
          eventId,
          sourceRef,
        });
        if (decCreated) {
          decisionsCreated++;
          auditEntries.push(auditCreated(sourceRef, "decision", decision.id, dec.text.trim().slice(0, 80)));
        } else {
          auditEntries.push(auditUpdated(sourceRef, "decision", decision.id, dec.text.trim().slice(0, 80)));
        }

        // Consequence actions inherit the same review flag as their parent decision.
        if (dec.consequences && dec.consequences.length > 0) {
          for (const consequence of dec.consequences) {
            if (!consequence.trim()) continue;
            try {
              const { item: action, created: actCreated } = await createActionTracked(username, {
                text: consequence.trim(),
                source: "slack",
                eventId,
                sourceRef,
                needsReview: needsReviewFlag(dTier),
                linkedDecisionIds: [decision.id],
              });
              await linkActionToDecision(username, decision.id, action.id);
              if (actCreated) {
                actionsCreated++;
                auditEntries.push(auditCreated(sourceRef, "action", action.id, consequence.trim().slice(0, 80)));
              }
            } catch {
              // Non-fatal
            }
          }
        }
      } catch (e) {
        console.error("[slack-materialize] failed to create decision:", e);
        auditEntries.push(auditFailed(sourceRef, "decision", e instanceof Error ? e.message : String(e)));
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
      content: `[Slack ${channelLabel} — ${dateShort}] ${intel.keyContext.trim()}`,
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
        content: `[Blocker — ${dateShort}] ${blocker.trim()} (raised in Slack ${channelLabel})`,
      });
    }
  }

  const mTier = memoryTier(intel.confidence);
  for (const mem of memoryCandidates) {
    if (!mem.content.trim()) continue;
    if (mTier === "skip") continue;
    try {
      const { item: memory, created } = await createMemoryTracked(username, {
        kind: "context",
        content: mem.content,
        entity: mem.entity,
        source: "inferred",
        confidence: intel.confidence,
        needsReview: needsReviewFlag(mTier),
        eventId,
        sourceRef,
      });
      if (created) {
        memoriesCreated++;
        auditEntries.push(auditCreated(sourceRef, "memory", memory.id, mem.content.slice(0, 80)));
      } else {
        auditEntries.push(auditUpdated(sourceRef, "memory", memory.id, mem.content.slice(0, 80)));
      }
    } catch (e) {
      console.error("[slack-materialize] failed to create memory:", e);
      auditEntries.push(auditFailed(sourceRef, "memory", e instanceof Error ? e.message : String(e)));
    }
  }

  return { actionsCreated, decisionsCreated, memoriesCreated, auditEntries };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Synthesize a fallback action text when the category implies one but
 * no explicit action items were found in the transcript.
 *
 * Only creates a synthesized action when Michael is addressed or when
 * the signal is unambiguously his to handle (blocker, escalation).
 */
function synthesizeSlackAction(
  category: SlackSignalCategory,
  channelLabel: string,
  from: string,
  isMichaelAddressed: boolean,
  isDM: boolean
): string {
  // In a DM the conversation is inherently with Michael — no isMichaelAddressed check needed.
  const addressed = isMichaelAddressed || isDM;

  switch (category) {
    case "action_assigned":
      // Only synthesize when Michael was explicitly named/addressed — a channel broadcast
      // saying "someone assigned X" is not necessarily Michael's task.
      return addressed
        ? `Follow up on action from ${from} in ${channelLabel}`
        : "";
    case "action_identified":
      // Don't synthesize for identified-but-not-assigned unless Michael is named
      return addressed
        ? `Review action item from ${from} in ${channelLabel}`
        : "";
    case "decision_needed":
      return addressed
        ? `Provide decision requested by ${from} in ${channelLabel}`
        : "";
    case "blocker_raised":
      // Blockers and escalations are always worth actioning — they affect Michael's work
      // even if he wasn't the one named. But only when confidence is sufficient (caller
      // already checked the tier).
      return `Unblock: ${from} flagged a blocker in ${channelLabel}`;
    case "escalation":
      return `Urgent: escalation from ${from} in ${channelLabel}`;
    case "meeting_signal":
      return addressed
        ? `Respond to scheduling request from ${from} in ${channelLabel}`
        : "";
    default:
      return "";
  }
}
