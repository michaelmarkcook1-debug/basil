/**
 * Process a Zoom meeting (from direct API) through the intelligence pipeline.
 *
 * For each meeting we have three possible data sources (richest first):
 *   1. Cloud recording transcript  → full verbatim text → run through extractZoomMeeting
 *   2. Participant list only        → create person memories for each attendee
 *   3. Meeting metadata only        → create a lightweight context memory
 *
 * Idempotent: sourceRef = "zoom-api:<meetingId>" — Jaccard dedup in createAction/
 * createDecision prevents double-writes if the same meeting was already processed
 * via the email pipeline.
 */

import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { MeetingIntelligenceSchema } from "@/lib/ai/schemas";
import { createAction } from "@/lib/actions/store";
import { createDecision } from "@/lib/decisions/store";
import { createMemory } from "@/lib/memory/store";
import { actionTier, decisionTier, memoryTier, needsReviewFlag } from "@/lib/trust/policy";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import type { ZoomMeeting, ZoomParticipant, ZoomRecording } from "./client";

export interface ProcessZoomMeetingOpts {
  username: string;
  meeting: ZoomMeeting;
  participants?: ZoomParticipant[];
  recording?: ZoomRecording;
  /** BasilEvent ID, if one was already created for this meeting. */
  eventId?: string;
}

export interface ProcessZoomMeetingResult {
  actionsCreated: number;
  decisionsCreated: number;
  memoriesCreated: number;
  skipped: boolean;
}

// ── Meeting extraction via LLM ────────────────────────────────────────────────

interface MeetingIntelligence {
  actions: Array<{ text: string; owner?: string; dueDate?: string; confidence: number }>;
  decisions: Array<{ text: string; title?: string; decidedBy?: string; rationale?: string; confidence: number }>;
  summary: string;
  keyTopics: string[];
}

async function extractMeetingIntelligence(
  username: string,
  topic: string,
  transcript: string,
  attendees: string[],
  date: string
): Promise<MeetingIntelligence | null> {
  try {
    const sysPrompt = await getSystemPrompt(username).catch(() => "");
    const { text } = await generateTextSafe({
      model: getTextModel("fast"),
      maxOutputTokens: MAX_TOKENS.fast,
      system: sysPrompt ||
        "You are an executive assistant extracting structured intelligence from meeting transcripts. Be conservative — only extract what is explicitly stated.",
      prompt: `Extract intelligence from this Zoom meeting transcript.

Meeting: "${topic}"
Date: ${date}
Attendees: ${attendees.join(", ") || "unknown"}

Transcript:
${transcript.slice(0, 7000)}

Return JSON only, no markdown:
{
  "actions": [{"text": "...", "owner": "...", "dueDate": "YYYY-MM-DD or null", "confidence": 0.0-1.0}],
  "decisions": [{"text": "...", "title": "...", "decidedBy": "...", "rationale": "...", "confidence": 0.0-1.0}],
  "summary": "2-3 sentence meeting summary",
  "keyTopics": ["topic1", "topic2"]
}

Rules:
- Only include actions that are explicit commitments with a clear owner or assignee
- Only include decisions that were explicitly confirmed/agreed, not just discussed
- Confidence 0.9 = explicit assignment; 0.7 = clear but unattributed; 0.5 = inferred
- Return empty arrays if nothing qualifies
- summary: factual, no speculation`,
    }, "fast", { username, feature: "zoom:process" });

    const parseResult = parseAndValidate(text, MeetingIntelligenceSchema, "[process-meeting]");
    return parseResult.ok ? parseResult.data : null;
  } catch {
    return null;
  }
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processZoomMeeting(
  opts: ProcessZoomMeetingOpts
): Promise<ProcessZoomMeetingResult> {
  const { username, meeting, participants = [], recording, eventId } = opts;
  const sourceRef = `zoom-api:${meeting.id}`;
  const dateStr = meeting.startTime?.split("T")[0] ?? new Date().toISOString().split("T")[0];
  let actionsCreated  = 0;
  let decisionsCreated = 0;
  let memoriesCreated  = 0;

  const attendeeNames = participants.map((p) => p.name).filter(Boolean);

  // ── Case 1: we have a transcript — full intelligence extraction ──────────────
  if (recording?.transcript && recording.transcript.trim().length > 100) {
    const intel = await extractMeetingIntelligence(
      username,
      meeting.topic,
      recording.transcript,
      attendeeNames,
      dateStr
    );

    if (intel) {
      // Actions
      for (const item of intel.actions) {
        const tier = actionTier(item.confidence);
        if (tier === "skip") continue;
        await createAction(username, {
          text:       item.text,
          owner:      item.owner ?? attendeeNames[0] ?? "Unknown",
          dueDate:    item.dueDate ?? undefined,
          source:     "meeting",
          confidence: item.confidence,
          needsReview: needsReviewFlag(tier),
          eventId,
          sourceRef,
        });
        actionsCreated++;
      }

      // Decisions
      const decisionIds: string[] = [];
      for (const dec of intel.decisions) {
        const tier = decisionTier(dec.confidence);
        if (tier === "skip") continue;
        const created = await createDecision(username, {
          text:       dec.text,
          title:      dec.title,
          rationale:  dec.rationale,
          decidedBy:  dec.decidedBy ?? attendeeNames[0] ?? "Unknown",
          date:       dateStr,
          context:    `Zoom meeting: ${meeting.topic}`,
          source:     "meeting",
          confidence: dec.confidence,
          needsReview: needsReviewFlag(tier),
          stakeholders: attendeeNames,
          eventId,
          sourceRef,
        });
        decisionIds.push(created.id);
        decisionsCreated++;
      }

      // Meeting summary → memory
      if (intel.summary) {
        const summaryText =
          `[Zoom meeting — ${meeting.topic}] ${dateStr}. ` +
          `Attendees: ${attendeeNames.join(", ") || "none listed"}. ` +
          intel.summary;

        const tier = memoryTier(0.85); // direct API data is high-confidence
        if (tier !== "skip") {
          await createMemory(username, {
            kind:    "context",
            content: summaryText,
            source:  "inferred",
            sourceRef,
            eventId,
          });
          memoriesCreated++;
        }
      }
    }
  }

  // ── Case 2: no transcript, but we have participants ─────────────────────────
  // Create person memories for each attendee and a lightweight meeting entry.
  if (actionsCreated === 0 && decisionsCreated === 0) {
    // Participant memories (contact recency)
    for (const p of participants) {
      if (!p.name) continue;
      await createMemory(username, {
        kind:    "person",
        content: `Zoom meeting participant: "${meeting.topic}" on ${dateStr}.`,
        entity:  p.name,
        source:  "inferred",
        sourceRef,
        eventId,
      }).catch(() => {}); // dedup handles duplicates
      memoriesCreated++;
    }

    // Lightweight meeting context memory
    if (meeting.topic) {
      await createMemory(username, {
        kind:    "context",
        content:
          `[Zoom meeting — ${meeting.topic}] ${dateStr}. ` +
          `Duration: ${meeting.duration ?? 0} min. ` +
          (attendeeNames.length > 0
            ? `Attendees: ${attendeeNames.join(", ")}.`
            : "No attendee data."),
        source:  "inferred",
        sourceRef,
        eventId,
      }).catch(() => {}); // fire-and-forget — dedup handles duplicates
      memoriesCreated++;
    }
  }

  return {
    actionsCreated,
    decisionsCreated,
    memoriesCreated,
    skipped: actionsCreated === 0 && decisionsCreated === 0 && memoriesCreated === 0,
  };
}
