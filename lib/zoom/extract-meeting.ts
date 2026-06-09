/**
 * Structured extraction from Zoom meeting summary / AI Companion emails.
 *
 * Takes a plain-text email body (HTML already stripped) and produces a typed
 * schema with: action items, decisions, attendees, summary, blockers,
 * follow-ups, and key topics.
 *
 * Design principles:
 * - Conservative extraction: only what is explicitly present in the email.
 * - Never fabricate: returns empty arrays rather than invented content.
 * - Never throws: callers don't need to guard against exceptions.
 * - Body clipped to 12 000 chars — covers full Zoom AI Companion emails
 *   including inline transcript sections without excessive token cost.
 */

import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { ZoomMeetingExtractSchema } from "@/lib/ai/schemas";

// ── Typed schema ───────────────────────────────────────────────────────────────

export interface ZoomActionItem {
  /** Action item description — explicit next step from the meeting. */
  text: string;
  /** Person responsible, if explicitly named in the summary. */
  owner?: string;
  /** Due date or timeframe if mentioned (ISO YYYY-MM-DD or free text). */
  dueDate?: string;
  /**
   * Per-item extraction confidence (0–1).
   * 0.9 = explicit assignment with owner + due date.
   * 0.7 = clearly stated next step without assignment details.
   * 0.5 = inferred from discussion, not an explicit commitment.
   * Falls back to meeting-level confidence when absent.
   */
  confidence?: number;
}

export interface ZoomDecision {
  /** Decision description — explicitly confirmed/agreed in the meeting. */
  text: string;
  /** Short scannable headline if discernible from context. */
  title?: string;
  /** Person who made / announced the decision, if named. */
  decidedBy?: string;
  /** Why this decision was made — only if explicitly stated. */
  rationale?: string;
  /** Alternatives explicitly mentioned as considered and rejected. */
  alternatives?: string[];
  /** Follow-up actions or consequences explicitly tied to this decision. */
  consequences?: string[];
  /**
   * Per-item extraction confidence (0–1).
   * 0.9 = explicitly confirmed/announced.
   * 0.7 = strongly implied but not announced in exact terms.
   * 0.5 = a proposal that was leaning toward acceptance.
   * Falls back to meeting-level confidence when absent.
   */
  confidence?: number;
}

export interface ZoomMeetingExtract {
  /** Meeting title or cleaned-up email subject. */
  meetingTitle: string;
  /** ISO date string for when the meeting occurred (not when the email arrived). */
  meetingDate: string;
  /** Full names of attendees, from participant lists or speaker references. */
  attendees: string[];
  /** 2–4 sentence summary of what was discussed and decided. */
  summary: string;
  /** Explicit action items with optional owners and due dates. */
  actionItems: ZoomActionItem[];
  /** Explicit decisions reached during the meeting. */
  decisions: ZoomDecision[];
  /** Blockers, risks, or open questions surfaced during the meeting. */
  blockers: string[];
  /** Follow-up items, pending threads, or next meetings mentioned. */
  followUps: string[];
  /** Key topics and themes discussed — not decisions or actions, just what was covered. */
  topics: string[];
  /** 0–1 extraction confidence (0.5 = sparse email, 1.0 = rich structured summary). */
  confidence: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Minimal safe fallback for failed or empty extractions. */
function emptyExtract(subject: string, date: string): ZoomMeetingExtract {
  return {
    meetingTitle: subject || "Zoom Meeting",
    meetingDate: date,
    attendees: [],
    summary: "",
    actionItems: [],
    decisions: [],
    blockers: [],
    followUps: [],
    topics: [],
    confidence: 0,
  };
}

/** Parse and validate the raw JSON response from the AI using Zod. */
function parseExtract(
  raw: string,
  fallback: { subject: string; date: string }
): ZoomMeetingExtract {
  const result = parseAndValidate(raw, ZoomMeetingExtractSchema, "[extract-meeting]");
  if (result.ok) {
    // Apply fallbacks for fields the model may have left empty
    const data = result.data as ZoomMeetingExtract;
    return {
      ...data,
      meetingTitle: data.meetingTitle || fallback.subject || "Zoom Meeting",
      meetingDate: data.meetingDate || fallback.date,
    };
  }
  throw new Error(result.error);
}

// ── Core extraction function ───────────────────────────────────────────────────

/**
 * Extract structured meeting intelligence from a Zoom summary email body.
 *
 * @param emailBody  Plain text body (HTML already stripped). First 6 000 chars used.
 * @param metadata   Subject and ISO date from the email envelope (used as fallbacks).
 * @param username   Required — the user who owns this meeting data. No fallback.
 *
 * @returns A fully-typed ZoomMeetingExtract. Never throws — returns empty extract on failure.
 */
export async function extractZoomMeeting(
  emailBody: string,
  metadata: { subject: string; date: string },
  username: string
): Promise<ZoomMeetingExtract> {
  if (!username) {
    console.error("[zoom-extract] username is required — refusing to extract without owner");
    return emptyExtract(metadata.subject, metadata.date);
  }

  if (!emailBody?.trim()) {
    return emptyExtract(metadata.subject, metadata.date);
  }

  // Clip to 12 000 chars — covers full Zoom AI Companion emails including inline
  // transcript sections. Zoom summaries with transcript typically run 6–10 K chars;
  // cutting at 12 K avoids token waste while capturing complete structured content.
  const body = emailBody.trim().slice(0, 12_000);
  const hasTranscript = /transcript|verbatim|conversation\s+log|speaker\s+label/i.test(body);

  const prompt = `Extract comprehensive meeting intelligence from this Zoom email. This may be an AI Companion summary, a meeting transcript, a recording notification with inline notes, or post-meeting notes. Extract everything useful.

EMAIL SUBJECT: ${metadata.subject}
EMAIL DATE: ${metadata.date}
${hasTranscript ? "NOTE: This email appears to contain a transcript or conversation log — extract speaker-attributed items carefully.\n" : ""}
EMAIL BODY:
${body}

EXTRACTION RULES (follow strictly):

1. actionItems — explicitly stated next steps, assigned tasks, or "to-do" items. Read transcript sections carefully for commitments made mid-conversation.
   - text: complete imperative sentence (e.g. "Send Q3 report to Ed by Friday")
   - owner: person explicitly assigned (omit key if unassigned)
   - dueDate: explicit deadline in ISO YYYY-MM-DD or natural language (omit key if none)
   - confidence: 0.9 = assigned with owner+date; 0.7 = clearly stated next step; 0.5 = loose "we should" commitment

2. decisions — things explicitly confirmed, agreed, or announced. In transcripts, look for phrases like "we decided", "agreed", "going with", "confirmed".
   - text: full decision as a complete sentence
   - title: ≤8 word scannable headline (omit if you can't form one cleanly)
   - decidedBy: person who announced it, if named (omit key if unclear)
   - rationale: reason given, ONLY if explicitly stated (omit key otherwise)
   - alternatives: options explicitly rejected (omit key if none mentioned)
   - consequences: direct follow-up commitments tied to this decision (omit key if none)
   - confidence: 0.9 = explicitly announced; 0.7 = clearly agreed; 0.5 = leaning toward acceptance

3. blockers — problems, risks, open questions, or dependencies that are blocking progress. Include anything phrased as "we're stuck on", "blocked by", "need to resolve", "open question", "risk".

4. followUps — pending threads, deferred topics, next meeting plans, or items explicitly marked "to revisit". Include things like "we'll circle back on X", "schedule a follow-up for Y".

5. topics — key themes and subjects discussed (2–8 items). NOT actions or decisions — just what was covered. Examples: "Q3 budget review", "hiring plan", "product roadmap", "customer feedback".

6. attendees — full names from participant lists, speaker labels, or name mentions. Exclude "Zoom AI Companion", bot names, and generic placeholders.

7. meetingDate — use the meeting's actual start time from the body (not email arrival date). ISO format preferred.

8. summary — 3–5 sentences covering: who was present, main topics discussed, key outcomes. If the body is just a short recording notification with no content, use empty string "".

9. confidence (meeting-level):
   - 0.9+ = full Zoom AI Companion output with structured sections
   - 0.7  = moderately rich with clear action items and attendees
   - 0.5  = partial notes or short summary without structure
   - 0.3  = sparse email, mostly boilerplate/link with little content

IMPORTANT: Extract from ALL sections — AI summary, transcript, action items list, and any inline notes. Empty arrays are always correct over invented content.

Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble:
{
  "meetingTitle": "string",
  "meetingDate": "ISO date string",
  "attendees": ["Full Name"],
  "summary": "3-5 sentence summary or empty string",
  "actionItems": [{"text": "imperative sentence", "owner": "name or omit", "dueDate": "date or omit", "confidence": 0.8}],
  "decisions": [{"text": "decision sentence", "title": "short headline or omit", "decidedBy": "name or omit", "rationale": "reason or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit, "confidence": 0.8}],
  "blockers": ["blocker description"],
  "followUps": ["follow-up item"],
  "topics": ["key topic"],
  "confidence": 0.8
}`;

  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateTextSafe(
      {
        model: getTextModel("default"),
        maxOutputTokens: MAX_TOKENS.long,  // 8192 — full transcript extracts need more output room
        system,
        messages: [{ role: "user", content: prompt }],
      },
      // Reserve at the "long" output budget (8192) to match maxOutputTokens above;
      // familyForTier("long") === "opus" so pricing is unchanged, only the
      // worst-case reservation grows to cover the real output ceiling.
      "long",
      { username, feature: "zoom:extract" }
    );

    return parseExtract(text, metadata);
  } catch (err) {
    console.error(
      "[zoom-extract] extraction failed:",
      err instanceof Error ? err.message : err
    );
    return emptyExtract(metadata.subject, metadata.date);
  }
}
