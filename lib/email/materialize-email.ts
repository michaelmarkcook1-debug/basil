/**
 * Materializes email intelligence into the canonical Basil stores:
 * Actions, Decisions, and Memory.
 *
 * Idempotency: handled upstream — poll-ingest skips emails whose externalId
 * already exists in the events store, so this function is never called twice
 * for the same message.
 *
 * Provenance fields on every created record:
 *   source    → "email"
 *   sourceRef → "gmail:<messageId>"
 *   eventId   → the BasilEvent that triggered this ingestion
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
import type { EmailIntelligence, EmailCategory } from "./classify-email";

// ── Input / output types ───────────────────────────────────────────────────────

export interface MaterializeEmailInput {
  /** Username to scope memory writes to. Required — no fallback. */
  username: string;
  intelligence: EmailIntelligence;
  /** Gmail message ID (without "gmail:" prefix). */
  messageId: string;
  /** BasilEvent ID created for this email. */
  eventId: string;
  /** Email subject — used as context label in created records. */
  subject: string;
  /** Sender display name. */
  from: string;
  /** ISO date string of the email. */
  date: string;
}

export interface MaterializeEmailResult {
  actionsCreated: number;
  decisionsCreated: number;
  memoriesCreated: number;
  /** Audit entries for every item outcome — ready to pass to appendAuditEntries. */
  auditEntries: AuditEntry[];
}

// ── Categories that trigger action creation ────────────────────────────────────

/** Categories that trigger action creation — including synthesized fallback when no explicit items found. */
const ACTION_CATEGORIES = new Set<EmailCategory>([
  "action_required",
  "decision_request",
  "follow_up_needed",
  "scheduling_signal",
]);

/**
 * Categories that produce actions ONLY when the AI explicitly extracted them.
 * We never synthesize a fallback "respond to" action for these — we only honour
 * what the AI found verbatim.
 */
const EXPLICIT_ONLY_ACTION_CATEGORIES = new Set<EmailCategory>([
  "relationship_signal",
]);

// ── Core function ──────────────────────────────────────────────────────────────

/**
 * Write intelligence outputs to Actions, Decisions, and Memory stores.
 *
 * Each store write is attempted independently so one failure does not abort
 * the others.  Errors are logged but never re-thrown.
 */
export async function materializeEmailIntelligence(
  input: MaterializeEmailInput
): Promise<MaterializeEmailResult> {
  const { intelligence: intel, messageId, eventId, subject, from, date, username } = input;

  if (!username) {
    console.error("[email-materialize] username is required — refusing to write without owner");
    return { actionsCreated: 0, decisionsCreated: 0, memoriesCreated: 0, auditEntries: [] };
  }

  const sourceRef = `gmail:${messageId}`;
  const dateShort = date.slice(0, 10);
  const shortSubject = subject.length > 60 ? subject.slice(0, 57) + "…" : subject;

  let actionsCreated = 0;
  let decisionsCreated = 0;
  let memoriesCreated = 0;
  const auditEntries: AuditEntry[] = [];

  // ── Trust policy tier for this email's confidence ─────────────────────────
  const aTier = actionTier(intel.confidence);
  const dTier = decisionTier(intel.confidence);

  // ── Actions ────────────────────────────────────────────────────────────────
  if (aTier !== "skip") {
    const isActionCategory = ACTION_CATEGORIES.has(intel.category);
    const isExplicitOnlyCategory = EXPLICIT_ONLY_ACTION_CATEGORIES.has(intel.category);

    if (intel.actions.length > 0 && (isActionCategory || isExplicitOnlyCategory)) {
      // Explicit extracted actions — honour for all qualifying category types
      for (const item of intel.actions) {
        if (!item.text?.trim()) continue;
        try {
          const { item: action, created } = await createActionTracked(username, {
            text: item.text.trim(),
            dueDate: item.dueDate,
            source: "email",
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
          console.error("[email-materialize] failed to create action:", e);
          auditEntries.push(auditFailed(sourceRef, "action", e instanceof Error ? e.message : String(e)));
        }
      }
    } else if (intel.actions.length === 0 && isActionCategory) {
      // No explicit actions extracted but the category implies one —
      // synthesize a canonical "respond to" action so nothing falls through.
      // (Never synthesize for relationship_signal — only honour explicit items.)
      const actionText = synthesizeActionText(intel.category, shortSubject, from);
      if (actionText) {
        try {
          const { item: action, created } = await createActionTracked(username, {
            text: actionText,
            source: "email",
            eventId,
            sourceRef,
            // Urgency drives priority for synthesized actions
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
          console.error("[email-materialize] failed to create synthesized action:", e);
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
          // Named people in the email are implicit stakeholders
          stakeholders: intel.people
            .map((p) => p.name)
            .filter((n) => n !== dec.decidedBy),
          date: dateShort,
          context: `From email: "${shortSubject}"`,
          source: "email",
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

        // Create follow-up actions from consequences and link them back.
        // Consequence actions inherit the same review flag as their parent decision.
        if (dec.consequences && dec.consequences.length > 0) {
          for (const consequence of dec.consequences) {
            if (!consequence.trim()) continue;
            try {
              const { item: action, created: actCreated } = await createActionTracked(username, {
                text: consequence.trim(),
                source: "email",
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
              // Non-fatal — decision was already created
            }
          }
        }
      } catch (e) {
        console.error("[email-materialize] failed to create decision:", e);
        auditEntries.push(auditFailed(sourceRef, "decision", e instanceof Error ? e.message : String(e)));
      }
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────────────
  // Persist key context as memory for: relationship signals, high-value
  // informational emails, and any email where keyContext was extracted.
  // Also add per-person relationship notes for relationship_signal emails.

  const memoryCandidates: Array<{ content: string; entity?: string }> = [];

  if (intel.keyContext.trim()) {
    const entity =
      intel.people.length > 0
        ? intel.people[0].name
        : intel.companies.length > 0
        ? intel.companies[0]
        : undefined;

    memoryCandidates.push({
      content: `[Email from ${from} — "${shortSubject}"] ${intel.keyContext.trim()}`,
      entity,
    });
  }

  // For relationship signals, store a brief note about each person mentioned
  // so future briefings can surface recent context about that contact.
  if (intel.category === "relationship_signal" && intel.people.length > 0) {
    for (const person of intel.people.slice(0, 3)) {
      if (!person.name?.trim()) continue;
      const roleNote = person.role ? ` (${person.role})` : "";
      memoryCandidates.push({
        content: `[${dateShort}] ${person.name}${roleNote} mentioned in email from ${from}: "${shortSubject}".`,
        entity: person.name.trim(),
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
      console.error("[email-materialize] failed to create memory:", e);
      auditEntries.push(auditFailed(sourceRef, "memory", e instanceof Error ? e.message : String(e)));
    }
  }

  return { actionsCreated, decisionsCreated, memoriesCreated, auditEntries };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Synthesize a "respond to" action when the category implies an action
 * but no explicit action items were extracted from the body.
 */
function synthesizeActionText(
  category: EmailCategory,
  shortSubject: string,
  from: string
): string {
  switch (category) {
    case "action_required":
      return `Respond to ${from} re: "${shortSubject}"`;
    case "decision_request":
      return `Decision needed — respond to ${from} re: "${shortSubject}"`;
    case "follow_up_needed":
      return `Follow up with ${from} re: "${shortSubject}"`;
    case "scheduling_signal":
      return `Respond to scheduling request from ${from} re: "${shortSubject}"`;
    default:
      return "";
  }
}
