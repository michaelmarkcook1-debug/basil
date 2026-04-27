/**
 * Shared Gmail message materialization helpers.
 *
 * Both poll-ingest and the Gmail push-notification webhook call these so
 * every email ingest path produces durable Actions, Decisions, and Memory
 * records — not just Basil event receipts.
 *
 * Design:
 *  - Safe to call fire-and-forget (`void processRegularEmail(...)`)
 *  - Never throws — all errors are caught and logged
 *  - Idempotent — action/decision stores dedup by sourceRef + Jaccard similarity
 *  - Full email body is always fetched; snippet is used only as a fallback
 *
 * Provenance on every created record:
 *   source    → "email" (regular) | "meeting" (Zoom)
 *   sourceRef → "gmail:<messageId>"
 *   eventId   → the BasilEvent that triggered this ingestion
 */

import { getEmailBody } from "@/lib/google/gmail";
import { classifyEmail, shouldMaterialize } from "@/lib/email/classify-email";
import { materializeEmailIntelligence } from "@/lib/email/materialize-email";
import { extractZoomMeeting } from "@/lib/zoom/extract-meeting";
import { createAction } from "@/lib/actions/store";
import { createDecision, linkActionToDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";
import { updateEvent } from "@/lib/events/store";
import { isSelf } from "@/lib/self-identity";
import {
  zoomActionTier,
  zoomDecisionTier,
  memoryTier,
  needsReviewFlag,
  ZOOM_REVIEW_FLOOR,
} from "@/lib/trust/policy";

// ── HTML stripper ─────────────────────────────────────────────────────────────

function stripHtml(s: string): string {
  return s
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Regular email materialization ─────────────────────────────────────────────

export interface ProcessEmailOpts {
  /** Username to scope Google API calls to. Defaults to "michael" for webhook paths. */
  username?: string;
  /** Raw message ID (no source prefix). Only used when bodyFetcher is absent. */
  gmailId: string;
  /** Full external ID, e.g. "gmail:<id>" or "outlook:<id>" — used as sourceRef. */
  externalId: string;
  /** ID of the BasilEvent created for this email. */
  eventId: string;
  /** Email subject. */
  subject: string;
  /** Sender display name. */
  from: string;
  /**
   * Fallback date used when the body fetch cannot be reached.
   * Prefer ISO dates from the email envelope; omit to fall back to ingest time.
   */
  dateFallback?: string;
  /**
   * Short snippet (≤200 chars) used as body fallback if the body fetch fails.
   */
  snippetFallback?: string;
  /**
   * Optional body fetcher that overrides the default Gmail API fetch.
   * Use this for non-Gmail sources (e.g. Outlook via Microsoft Graph) so the
   * full message body is available for accurate AI classification.
   *
   * Must return `{ body?: string; date?: string }` or null — the same shape
   * as `getEmailBody` from lib/google/gmail.
   */
  bodyFetcher?: () => Promise<{ body?: string; date?: string } | null>;
}

/**
 * Classify a regular (non-Zoom) email and materialize any extracted
 * actions, decisions, and memory into the canonical stores.
 *
 * Supports both Gmail and non-Gmail sources (e.g. Outlook via Microsoft Graph)
 * via the optional `bodyFetcher` override.
 *
 * Called via next/server `after()` after the event record is created.
 */
export async function processRegularEmail(opts: ProcessEmailOpts): Promise<void> {
  const { gmailId, externalId, eventId, subject, from, dateFallback, snippetFallback, bodyFetcher, username = "michael" } = opts;

  try {
    let body = snippetFallback || "";
    let date = dateFallback || new Date().toISOString();

    try {
      // Use the caller-supplied fetcher when available (e.g. Outlook Graph API),
      // otherwise fall back to the Gmail API.
      const fullEmail = bodyFetcher ? await bodyFetcher() : await getEmailBody(username, gmailId);
      if (fullEmail?.body) {
        body = fullEmail.body.includes("<") ? stripHtml(fullEmail.body) : fullEmail.body;
      }
      // Prefer the email's actual send date over the caller-provided date
      if (fullEmail?.date) {
        date = fullEmail.date;
      }
    } catch {
      // Fall back to snippet + caller-provided date — better than nothing
    }

    const intel = await classifyEmail({ subject, from, date, snippet: "", body });

    console.log(
      `[email-process] ${externalId} → ${intel.category} (confidence=${intel.confidence})`
    );

    if (!shouldMaterialize(intel)) return;

    const result = await materializeEmailIntelligence({
      intelligence: intel,
      messageId: gmailId,
      eventId,
      subject,
      from,
      date,
    });

    if (result.actionsCreated + result.decisionsCreated + result.memoriesCreated > 0) {
      console.log(
        `[email-process] materialized ${externalId}: ` +
        `${result.actionsCreated} action(s), ${result.decisionsCreated} decision(s), ` +
        `${result.memoriesCreated} memory item(s)`
      );
    }
  } catch (err) {
    console.error(
      `[email-process] failed for ${externalId}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ── Zoom email materialization ─────────────────────────────────────────────────

export interface ProcessZoomEmailOpts {
  /** Username to scope Google API calls to. Defaults to "michael" for webhook paths. */
  username?: string;
  /** Raw Gmail message ID (no "gmail:" prefix). */
  gmailId: string;
  /** "gmail:<id>" — used as sourceRef on every created record. */
  externalId: string;
  /** ID of the BasilEvent created for this email. */
  eventId: string;
  /** Email subject (used as fallback meeting title). */
  subject: string;
  /**
   * Fallback date used when getEmailBody cannot be reached.
   * Prefer ISO dates from the Gmail envelope; omit to fall back to ingest time.
   */
  dateFallback?: string;
}

/**
 * Run structured extraction from a Zoom meeting summary email and materialize
 * the results into the canonical stores:
 *  - Action items → Actions store (with needsReview based on confidence tier)
 *  - Decisions → Decisions store (with follow-up consequence actions linked)
 *  - Meeting summary → Memory store (kind:"context")
 *  - Per-attendee touchpoints → Memory store (kind:"person", for contact recency)
 *
 * Called fire-and-forget after the event record is created.
 */
export async function processZoomEmail(opts: ProcessZoomEmailOpts): Promise<void> {
  const { gmailId, externalId, eventId, subject, dateFallback, username = "michael" } = opts;

  try {
    const fullEmail = await getEmailBody(username, gmailId);
    if (!fullEmail?.body) {
      console.warn(`[zoom-process] body empty for ${externalId} — skipping extraction`);
      return;
    }

    const plainBody = fullEmail.body.includes("<")
      ? stripHtml(fullEmail.body)
      : fullEmail.body;
    // Prefer the email's actual send date from internalDate
    const date = fullEmail.date || dateFallback || new Date().toISOString();

    const extract = await extractZoomMeeting(plainBody, { subject, date });

    console.log(
      `[zoom-process] extracted for ${externalId}: ` +
      `${extract.actionItems.length} action(s), ${extract.decisions.length} decision(s), ` +
      `${extract.attendees.length} attendee(s), confidence=${extract.confidence}`
    );

    if (extract.confidence < ZOOM_REVIEW_FLOOR) {
      console.log(
        `[zoom-process] confidence=${extract.confidence} below floor (${ZOOM_REVIEW_FLOOR}) — skipping materialization`
      );
      return;
    }

    const sourceRef = externalId;
    const zoomATier = zoomActionTier(extract.confidence);
    const zoomDTier = zoomDecisionTier(extract.confidence);
    const zoomMTier = memoryTier(extract.confidence);

    // ── Action items ──────────────────────────────────────────────────────────
    // Per-item confidence (when present) overrides meeting-level confidence so
    // a high-quality email can still suppress individual low-confidence items.
    let actionsCreated = 0;
    if (zoomATier !== "skip") {
      for (const item of extract.actionItems) {
        if (!item.text?.trim()) continue;
        const itemConf = item.confidence ?? extract.confidence;
        const itemTier = zoomActionTier(itemConf);
        if (itemTier === "skip") continue;
        try {
          const textLower = item.text.toLowerCase();
          const priority =
            /urgent|asap|immediately|today|blocker|critical/.test(textLower)
              ? ("high" as const)
              : /this week|by \w+day|follow.?up/.test(textLower)
              ? ("medium" as const)
              : ("low" as const);
          await createAction({
            text: item.text.trim(),
            owner: item.owner || "Michael Cook",
            dueDate: item.dueDate,
            source: "meeting",
            eventId,
            sourceRef,
            priority,
            confidence: itemConf,
            needsReview: needsReviewFlag(itemTier),
          });
          actionsCreated++;
        } catch (e) {
          console.error("[zoom-process] failed to create action:", e);
        }
      }
    } else {
      console.log(
        `[zoom-process] action tier=skip (conf=${extract.confidence}) for ${externalId}`
      );
    }

    // ── Decisions ─────────────────────────────────────────────────────────────
    let decisionsCreated = 0;
    if (zoomDTier !== "skip") {
      for (const dec of extract.decisions) {
        if (!dec.text?.trim()) continue;
        const itemConf = dec.confidence ?? extract.confidence;
        const itemTier = zoomDecisionTier(itemConf);
        if (itemTier === "skip") continue;
        try {
          const decision = await createDecision({
            text: dec.text.trim(),
            title: dec.title?.trim(),
            rationale: dec.rationale?.trim(),
            alternatives: dec.alternatives,
            consequences: dec.consequences,
            decidedBy: dec.decidedBy || "Meeting attendees",
            stakeholders: extract.attendees.filter((a) => a !== dec.decidedBy),
            date: extract.meetingDate.slice(0, 10),
            context: `From Zoom meeting: ${extract.meetingTitle}`,
            source: "meeting",
            confidence: itemConf,
            needsReview: needsReviewFlag(itemTier),
            eventId,
            sourceRef,
          });
          decisionsCreated++;

          // Create follow-up actions for explicit decision consequences
          for (const consequence of dec.consequences ?? []) {
            if (!consequence.trim()) continue;
            try {
              const action = await createAction({
                text: consequence.trim(),
                owner: "Michael Cook",
                source: "meeting",
                eventId,
                sourceRef,
                confidence: itemConf,
                needsReview: needsReviewFlag(itemTier),
                linkedDecisionIds: [decision.id],
              });
              await linkActionToDecision(decision.id, action.id);
              actionsCreated++;
            } catch {
              /* non-fatal — decision was already created */
            }
          }
        } catch (e) {
          console.error("[zoom-process] failed to create decision:", e);
        }
      }
    } else {
      console.log(
        `[zoom-process] decision tier=skip (conf=${extract.confidence}) for ${externalId}`
      );
    }

    if (actionsCreated > 0) {
      console.log(`[zoom-process] materialized ${actionsCreated} action(s) for ${externalId}`);
    }
    if (decisionsCreated > 0) {
      console.log(`[zoom-process] materialized ${decisionsCreated} decision(s) for ${externalId}`);
    }

    // ── Meeting summary memory ────────────────────────────────────────────────
    if (extract.summary?.trim() && zoomMTier !== "skip") {
      const attendeeNote =
        extract.attendees.length > 0
          ? ` Attendees: ${extract.attendees.slice(0, 6).join(", ")}.`
          : "";
      try {
        await createMemory(username, {
          kind: "context",
          content: `[Zoom meeting — ${extract.meetingTitle}]${attendeeNote} ${extract.summary.trim()}`,
          source: "inferred",
          confidence: extract.confidence,
          needsReview: needsReviewFlag(zoomMTier),
          eventId,
          sourceRef,
        });
      } catch (e) {
        console.error("[zoom-process] failed to create summary memory:", e);
      }
    }

    // ── Per-attendee person memories (contact recency tracking) ───────────────
    // Uses kind:"person" so the contacts/activity route can query them separately
    // from general context memories. Gated on the low ZOOM_REVIEW_FLOOR rather
    // than zoomMTier because attendee presence is factual, not probabilistic.
    if (extract.attendees.length > 0 && extract.confidence >= ZOOM_REVIEW_FLOOR) {
      const meetingDateStr = extract.meetingDate.slice(0, 10);
      const participants = extract.attendees
        .filter((a) => a.trim() && !isSelf(a))
        .slice(0, 8);
      for (const attendee of participants) {
        try {
          await createMemory(username, {
            kind: "person",
            content: `Zoom meeting participant: "${extract.meetingTitle}" on ${meetingDateStr}.`,
            entity: attendee.trim(),
            source: "inferred",
            confidence: extract.confidence,
            needsReview: false,
            eventId,
            sourceRef,
          });
        } catch (e) {
          console.error("[zoom-process] failed to create attendee memory:", e);
        }
      }
    }

    // ── Update event context with extraction summary ───────────────────────────
    // Appends a human-readable extraction summary to the event's context field
    // so the "Basil is watching" UI can surface item counts per event.
    try {
      const extractionSummary = [
        `Extraction: ${extract.actionItems.length} action(s), ${extract.decisions.length} decision(s), ${extract.attendees.length} attendee(s).`,
        extract.summary ? `Summary: ${extract.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await updateEvent(eventId, { context: extractionSummary });
    } catch {
      /* non-fatal — UI context update failing does not affect durable records */
    }
  } catch (err) {
    console.error(
      `[zoom-process] failed for ${externalId}:`,
      err instanceof Error ? err.message : err
    );
  }
}
