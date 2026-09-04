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
import { writeToneObservations } from "@/lib/contacts/tone-store";
import { touchContactsRecency } from "@/lib/contacts/touch-recency";
import { createActionTracked } from "@/lib/actions/store";
import { createDecisionTracked, linkActionToDecision } from "@/lib/decisions/store";
import { createMemoryTracked } from "@/lib/memory/store";
import { updateEvent } from "@/lib/events/store";
import { getSelfIdentity, isSelf } from "@/lib/self-identity";
import {
  zoomActionTier,
  zoomDecisionTier,
  memoryTier,
  needsReviewFlag,
  ZOOM_REVIEW_FLOOR,
} from "@/lib/trust/policy";
import { hashContent } from "@/lib/ingest/content-hash";
import { isHashUnchanged, recordIngest } from "@/lib/ingest/index";
import { enrichContactLinkedIn } from "@/lib/contacts/enrich-linkedin";
import {
  appendAuditEntries,
  auditSkipped,
  auditCreated,
  auditFailed,
  type AuditEntry,
} from "@/lib/ingest/audit-log";
import { getFlags } from "@/core/feature-flags";
import { runGmailShadow } from "@/core/ingestion/shadow-runner";
import { normalizeGmailSignal } from "@/core/signals/normalizers/gmail.normalizer";
import { enrichAndWriteSignal } from "@/core/ingestion/signal-pipeline";

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
  /** Username to scope Google API calls to. Required — no fallback. */
  username: string;
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
  const { gmailId, externalId, eventId, subject, from, dateFallback, snippetFallback, bodyFetcher, username } = opts;

  if (!username) {
    console.error("[process-gmail] username is required — refusing to process without owner", { externalId });
    return;
  }

  try {
    let body = snippetFallback || "";
    let date = dateFallback || new Date().toISOString();
    // The UNSTRIPPED body, kept for signature harvesting. stripHtml() removes
    // whole tags, so an HTML signature's <a href="…linkedin.com/in/…"> loses
    // its URL entirely — the link text survives, the address does not.
    let rawBody = body;
    let senderEmail: string | undefined;

    try {
      // Use the caller-supplied fetcher when available (e.g. Outlook Graph API),
      // otherwise fall back to the Gmail API.
      const fullEmail = bodyFetcher ? await bodyFetcher() : await getEmailBody(username, gmailId);
      if (fullEmail?.body) {
        rawBody = fullEmail.body;
        body = fullEmail.body.includes("<") ? stripHtml(fullEmail.body) : fullEmail.body;
      }
      // "Name <addr@host>" → addr@host. Matching contacts on the ADDRESS is what
      // makes attribution safe; display names collide and are trivially spoofed.
      const rawFrom = (fullEmail as { from?: string } | undefined)?.from ?? from ?? "";
      senderEmail = rawFrom.match(/<([^>]+@[^>]+)>/)?.[1] ?? (rawFrom.includes("@") ? rawFrom.trim() : undefined);
      // Prefer the email's actual send date over the caller-provided date
      if (fullEmail?.date) {
        date = fullEmail.date;
      }
    } catch {
      // Fall back to snippet + caller-provided date — better than nothing
    }

    // ── Content hash idempotency check ────────────────────────────────────────
    // Skip the AI call entirely if the content hasn't changed since last ingest.
    const sourceRef = externalId;
    const contentHash = hashContent(subject, body);
    const unchanged = await isHashUnchanged(username, sourceRef, contentHash);
    if (unchanged) {
      console.log(`[email-process] ${externalId} unchanged (hash match) — skipping`);
      void appendAuditEntries(username, [
        auditSkipped(sourceRef, "action", `Content hash unchanged for ${externalId}`),
      ]);
      return;
    }

    // Harvest a LinkedIn profile from the sender's signature. Runs on new
    // content only (past the hash gate above), costs no AI call, and never
    // throws — see enrichContactLinkedIn for the attribution safeguards.
    void enrichContactLinkedIn(username, senderEmail, rawBody);

    const intel = await classifyEmail({ username, subject, from, date, snippet: "", body });

    console.log(
      `[email-process] ${externalId} → ${intel.category} (confidence=${intel.confidence})`
    );

    // ── Shadow comparison (runs on ALL classified emails, not just materialized) ──
    // This gives parity data for every email that has new content, regardless of
    // whether the old pipeline decided to materialize it. Moving this before
    // shouldMaterialize avoids missing shadow comparisons for low-confidence emails.
    const flagsForShadow = await getFlags(username);
    const normInputForShadow = { opts, body, date, senderIsKnown: true };
    if (flagsForShadow.signalEvent_shadow) {
      void runGmailShadow(normInputForShadow, contentHash, username);
    }

    // A FAILED classification is not a verdict. Recording its hash here is what
    // made a provider outage permanent: the placeholder is
    // category:"low_value_noise", shouldMaterialize says no, the hash gets
    // written, and isHashUnchanged skips the message forever — so mail that
    // arrived while the AI was down was written off as junk and never
    // reconsidered. Leave it unrecorded so the next run retries it.
    if (intel.classificationFailed) {
      console.warn(
        `[email-process] ${sourceRef} classification FAILED (provider error) — ` +
        `not recording hash so it is retried once AI is healthy`
      );
      return;
    }

    if (!shouldMaterialize(intel)) {
      // Record in index so we don't re-classify this message on the next poll
      void recordIngest(username, { sourceRef, hash: contentHash });
      return;
    }

    const result = await materializeEmailIntelligence({
      intelligence: intel,
      messageId: gmailId,
      sourceRef, // real provider-prefixed ref (gmail:/outlook:) — not a fabricated gmail: id
      eventId,
      subject,
      from,
      date,
      username,
    });

    // ── Record in ingest index + emit audit ───────────────────────────────────
    const actionIds = result.auditEntries
      .filter((e) => e.itemType === "action" && e.itemId)
      .map((e) => e.itemId!);
    const decisionIds = result.auditEntries
      .filter((e) => e.itemType === "decision" && e.itemId)
      .map((e) => e.itemId!);
    const memoryIds = result.auditEntries
      .filter((e) => e.itemType === "memory" && e.itemId)
      .map((e) => e.itemId!);

    void recordIngest(username, { sourceRef, hash: contentHash, actionIds, decisionIds, memoryIds });
    void appendAuditEntries(username, result.auditEntries);

    // ── Write back-links on the originating BasilEvent ────────────────────────
    // This lets the Events feed show "spawned 2 actions, 1 decision" per event.
    if (actionIds.length > 0 || decisionIds.length > 0 || memoryIds.length > 0) {
      const backLink: Record<string, string> = {};
      if (actionIds[0]) backLink.actionId = actionIds[0];
      if (decisionIds[0]) backLink.decisionId = decisionIds[0];
      if (memoryIds[0]) backLink.memoryId = memoryIds[0];
      void updateEvent(username, eventId, backLink).catch(() => { /* ci-ok: back-link is UI-only, durable records already written */ });
    }

    if (result.actionsCreated + result.decisionsCreated + result.memoriesCreated > 0) {
      console.log(
        `[email-process] materialized ${externalId}: ` +
        `${result.actionsCreated} action(s), ${result.decisionsCreated} decision(s), ` +
        `${result.memoriesCreated} memory item(s)`
      );
    }

    // ── Primitive pipeline (Week 1-2 gated) ──────────────────────────────────
    // signalEvent_shadow — already fired above (before shouldMaterialize) so
    //   we capture parity data for all classified emails, not just materialized ones.
    // signalEvent_active → dual-write: write SignalEvent alongside old stores.
    // Fire-and-forget blocks: never throw into the old pipeline.
    const flags = flagsForShadow; // reuse flags already fetched above
    const normInput = normInputForShadow; // reuse normInput already built above

    if (flags.signalEvent_active) {
      // Dual-write: produce a fully-populated SignalEvent, enrich it through
      // the pipeline (identity resolution → ranking → write → thread upsert),
      // all gated on individual flags. Fire-and-forget — never throws here.
      void (async () => {
        try {
          const signal = normalizeGmailSignal(normInput);
          signal.actionIds = actionIds;
          signal.decisionIds = decisionIds;
          signal.memoryIds = memoryIds;
          signal.category = (intel.category as typeof signal.category) ?? "unknown";
          signal.actions = (intel.actions ?? []).map((a) => ({
            text: a.text,
            dueDate: a.dueDate,
            priority: a.priority,
          }));
          signal.decisions = (intel.decisions ?? []).map((d) => ({
            text: d.text,
            title: d.title,
            decidedBy: d.decidedBy,
            rationale: d.rationale,
            alternatives: d.alternatives,
            consequences: d.consequences,
          }));
          await enrichAndWriteSignal(username, signal, flags);
        } catch (err) {
          console.error(
            `[process-gmail] signalEvent_active pipeline failed for ${externalId}:`,
            err instanceof Error ? err.message : err
          );
        }
      })();
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[email-process] failed for ${externalId}:`, errMsg);
    void appendAuditEntries(username, [
      auditFailed(externalId, "action", errMsg, `processRegularEmail failed for ${externalId}`),
    ]);
  }
}

// ── Zoom email materialization ─────────────────────────────────────────────────

export interface ProcessZoomEmailOpts {
  /** Username to scope Google API calls to. Required — no fallback. */
  username: string;
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
  const { gmailId, externalId, eventId, subject, dateFallback, username } = opts;

  if (!username) {
    console.error("[process-zoom-email] username is required — refusing to process without owner", { externalId });
    return;
  }

  // Resolve self-identity up-front so attendee filtering uses the actual user.
  const selfIdentity = await getSelfIdentity(username);

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

    // ── Content hash idempotency check ────────────────────────────────────────
    const sourceRef = externalId;
    const contentHash = hashContent(subject, plainBody);
    const unchanged = await isHashUnchanged(username, sourceRef, contentHash);
    if (unchanged) {
      console.log(`[zoom-process] ${externalId} unchanged (hash match) — skipping`);
      void appendAuditEntries(username, [
        auditSkipped(sourceRef, "action", `Zoom content hash unchanged for ${externalId}`),
      ]);
      return;
    }

    const extract = await extractZoomMeeting(plainBody, { subject, date }, username);

    console.log(
      `[zoom-process] extracted for ${externalId}: ` +
      `${extract.actionItems.length} action(s), ${extract.decisions.length} decision(s), ` +
      `${extract.attendees.length} attendee(s), confidence=${extract.confidence}`
    );

    if (extract.confidence < ZOOM_REVIEW_FLOOR) {
      console.log(
        `[zoom-process] confidence=${extract.confidence} below floor (${ZOOM_REVIEW_FLOOR}) — skipping materialization`
      );
      void recordIngest(username, { sourceRef, hash: contentHash });
      return;
    }

    const zoomAuditEntries: AuditEntry[] = [];
    const zoomATier = zoomActionTier(extract.confidence);
    const zoomDTier = zoomDecisionTier(extract.confidence);
    const zoomMTier = memoryTier(extract.confidence);

    // Tone observations → per-contact tone history (same store as email/Slack and
    // the Zoom-API path). Zoom-recap emails now contribute to tone + contact
    // tracing, not just actions/decisions/memory.
    if (extract.toneShifts?.length) {
      await writeToneObservations(username, extract.toneShifts, extract.meetingDate || date, "zoom", sourceRef).catch((err) => {
        console.error("[zoom-process] tone observation write failed:", err instanceof Error ? err.message : err);
      });
    }

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
          const { item: action, created } = await createActionTracked(username, {
            text: item.text.trim(),
            owner: item.owner,
            dueDate: item.dueDate,
            source: "meeting",
            eventId,
            sourceRef,
            priority,
            confidence: itemConf,
            needsReview: needsReviewFlag(itemTier),
          });
          if (created) {
            actionsCreated++;
            zoomAuditEntries.push(auditCreated(sourceRef, "action", action.id, item.text.trim().slice(0, 80)));
          }
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
          const { item: decision, created: decCreated } = await createDecisionTracked(username, {
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
          if (decCreated) {
            decisionsCreated++;
            zoomAuditEntries.push(auditCreated(sourceRef, "decision", decision.id, dec.text.trim().slice(0, 80)));
          }

          // Create follow-up actions for explicit decision consequences
          for (const consequence of dec.consequences ?? []) {
            if (!consequence.trim()) continue;
            try {
              const { item: action, created: actCreated } = await createActionTracked(username, {
                text: consequence.trim(),
                source: "meeting",
                eventId,
                sourceRef,
                confidence: itemConf,
                needsReview: needsReviewFlag(itemTier),
                linkedDecisionIds: [decision.id],
              });
              await linkActionToDecision(username, decision.id, action.id);
              if (actCreated) {
                actionsCreated++;
                zoomAuditEntries.push(auditCreated(sourceRef, "action", action.id, consequence.trim().slice(0, 80)));
              }
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

    // ── Blockers → high-priority actions ────────────────────────────────────
    // Blockers are things explicitly flagged as blocking progress. Surface them
    // as high-priority action items so they don't get buried in meeting notes.
    if (extract.blockers?.length > 0 && zoomATier !== "skip") {
      for (const blocker of extract.blockers) {
        if (!blocker.trim()) continue;
        try {
          const blockerText = blocker.trim().startsWith("Blocker:")
            ? blocker.trim()
            : `Blocker: ${blocker.trim()}`;
          const { item: action, created } = await createActionTracked(username, {
            text: blockerText,
            source: "meeting",
            eventId,
            sourceRef,
            priority: "high",
            confidence: extract.confidence,
            needsReview: needsReviewFlag(zoomATier),
          });
          if (created) {
            actionsCreated++;
            zoomAuditEntries.push(auditCreated(sourceRef, "action", action.id, blockerText.slice(0, 80)));
          }
        } catch (e) {
          console.error("[zoom-process] failed to create blocker action:", e);
        }
      }
    }

    // ── Follow-ups → medium-priority actions ──────────────────────────────────
    // Follow-ups are deferred items, next-steps, or pending threads. Surface
    // them as actions so nothing slips through after the meeting.
    if (extract.followUps?.length > 0 && zoomATier !== "skip") {
      for (const followUp of extract.followUps) {
        if (!followUp.trim()) continue;
        try {
          const followUpText = followUp.trim().startsWith("Follow up:")
            ? followUp.trim()
            : `Follow up: ${followUp.trim()}`;
          const { item: action, created } = await createActionTracked(username, {
            text: followUpText,
            source: "meeting",
            eventId,
            sourceRef,
            priority: "medium",
            confidence: extract.confidence,
            needsReview: needsReviewFlag(zoomATier),
          });
          if (created) {
            actionsCreated++;
            zoomAuditEntries.push(auditCreated(sourceRef, "action", action.id, followUpText.slice(0, 80)));
          }
        } catch (e) {
          console.error("[zoom-process] failed to create follow-up action:", e);
        }
      }
    }

    if (actionsCreated > 0) {
      console.log(`[zoom-process] materialized ${actionsCreated} action(s) for ${externalId}`);
    }
    if (decisionsCreated > 0) {
      console.log(`[zoom-process] materialized ${decisionsCreated} decision(s) for ${externalId}`);
    }

    // ── Meeting summary memory ────────────────────────────────────────────────
    if (extract.summary?.trim() && zoomMTier !== "skip") {
      // Build a rich memory record that includes topics covered so the briefing
      // and chat can surface relevant meeting context by topic.
      const attendeeNote =
        extract.attendees.length > 0
          ? ` Attendees: ${extract.attendees.slice(0, 6).join(", ")}.`
          : "";
      const topicNote =
        extract.topics?.length > 0
          ? ` Topics covered: ${extract.topics.slice(0, 5).join("; ")}.`
          : "";
      const blockerNote =
        extract.blockers?.length > 0
          ? ` Open blockers: ${extract.blockers.slice(0, 3).join("; ")}.`
          : "";
      try {
        const { item: memory, created } = await createMemoryTracked(username, {
          kind: "context",
          content: `[Zoom meeting — ${extract.meetingTitle}]${attendeeNote}${topicNote}${blockerNote} ${extract.summary.trim()}`,
          source: "inferred",
          confidence: extract.confidence,
          needsReview: needsReviewFlag(zoomMTier),
          eventId,
          sourceRef,
        });
        if (created) {
          zoomAuditEntries.push(auditCreated(sourceRef, "memory", memory.id, extract.summary.trim().slice(0, 80)));
        }
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
        .filter((a) => a.trim() && !isSelf(a, selfIdentity))
        .slice(0, 8);
      // Advance contact recency for Zoom attendees so a recent call counts toward
      // "last interaction" — the delta engine's "gone quiet" signal reads that
      // field, and Zoom participation previously never updated it.
      await touchContactsRecency(
        username,
        participants.map((a) => ({ name: a.trim(), date: meetingDateStr, source: "zoom" }))
      ).catch(() => 0);
      for (const attendee of participants) {
        try {
          const { item: memory, created } = await createMemoryTracked(username, {
            kind: "person",
            content: `Zoom meeting participant: "${extract.meetingTitle}" on ${meetingDateStr}.`,
            entity: attendee.trim(),
            source: "inferred",
            confidence: extract.confidence,
            needsReview: false,
            eventId,
            sourceRef,
          });
          if (created) {
            zoomAuditEntries.push(auditCreated(sourceRef, "memory", memory.id, `Attendee: ${attendee.trim()}`));
          }
        } catch (e) {
          console.error("[zoom-process] failed to create attendee memory:", e);
        }
      }
    }

    // ── Update event context + back-links ────────────────────────────────────
    // Context: human-readable extraction summary for the Events feed.
    // Back-links: typed IDs so the event record knows what it spawned.
    try {
      const extractionSummary = [
        `Extraction: ${extract.actionItems.length} action(s), ${extract.decisions.length} decision(s), ${extract.attendees.length} attendee(s).`,
        extract.summary ? `Summary: ${extract.summary}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const firstActionId = zoomAuditEntries.find((e) => e.itemType === "action" && e.itemId)?.itemId;
      const firstDecisionId = zoomAuditEntries.find((e) => e.itemType === "decision" && e.itemId)?.itemId;
      const firstMemoryId = zoomAuditEntries.find((e) => e.itemType === "memory" && e.itemId)?.itemId;
      await updateEvent(username, eventId, {
        context: extractionSummary,
        ...(firstActionId ? { actionId: firstActionId } : {}),
        ...(firstDecisionId ? { decisionId: firstDecisionId } : {}),
        ...(firstMemoryId ? { memoryId: firstMemoryId } : {}),
      });
    } catch {
      /* non-fatal — UI context update failing does not affect durable records */
    }

    // ── Record in ingest index + emit audit ───────────────────────────────────
    const zoomActionIds = zoomAuditEntries
      .filter((e) => e.itemType === "action" && e.itemId)
      .map((e) => e.itemId!);
    const zoomDecisionIds = zoomAuditEntries
      .filter((e) => e.itemType === "decision" && e.itemId)
      .map((e) => e.itemId!);
    const zoomMemoryIds = zoomAuditEntries
      .filter((e) => e.itemType === "memory" && e.itemId)
      .map((e) => e.itemId!);

    void recordIngest(username, {
      sourceRef,
      hash: contentHash,
      actionIds: zoomActionIds,
      decisionIds: zoomDecisionIds,
      memoryIds: zoomMemoryIds,
    });
    void appendAuditEntries(username, zoomAuditEntries);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[zoom-process] failed for ${externalId}:`, errMsg);
    void appendAuditEntries(username, [
      auditFailed(externalId, "action", errMsg, `processZoomEmail failed for ${externalId}`),
    ]);
  }
}
