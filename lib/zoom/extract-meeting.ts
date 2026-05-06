/**
 * Structured extraction from Zoom meeting summary / AI Companion emails.
 *
 * Takes a plain-text email body (HTML already stripped) and produces a typed
 * schema with: action items, decisions, attendees, summary, blockers, and
 * follow-ups.
 *
 * Design principles:
 * - Conservative extraction: only what is explicitly present in the email.
 * - Never fabricate: returns empty arrays rather than invented content.
 * - Never throws: callers don't need to guard against exceptions.
 * - Cheap by default: clips email body to 6 000 chars so AI cost is bounded.
 */

import { generateText } from "ai";
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

  // Clip to 6 000 chars — Zoom AI Companion summaries rarely exceed this,
  // and it keeps extraction cost predictable.
  const body = emailBody.trim().slice(0, 6_000);

  const prompt = `Extract structured meeting intelligence from this Zoom meeting summary email.

EMAIL SUBJECT: ${metadata.subject}
EMAIL DATE: ${metadata.date}

EMAIL BODY:
${body}

Extraction rules — follow these strictly:
1. Extract ONLY what is explicitly present. Do not infer or fabricate.
2. actionItems: only include explicitly stated next steps or assigned tasks — NOT vague discussion topics. Each item must have a "text" field; other keys are optional.
   - text: the exact action as a complete imperative sentence (e.g. "Send the Q3 report to Ed by Friday")
   - owner: person explicitly assigned, if named — omit key if unassigned
   - dueDate: explicit deadline if stated — omit key if none given
   - confidence: 0.9 if explicitly assigned with owner+date; 0.7 if clearly stated but unassigned; 0.5 if mentioned as "we should" without commitment
3. decisions: only include things explicitly confirmed, agreed, or announced — NOT tentative discussions, proposals under debate, or questions raised.
   - text: the full decision statement as a complete sentence
   - title: a short (≤8 word) scannable headline for the decision, if you can form one cleanly
   - decidedBy: person who confirmed/announced it, if explicitly named
   - rationale: the reason given for the decision, ONLY if explicitly stated in the text — omit key if not stated
   - alternatives: options explicitly mentioned as considered and rejected — omit key if none stated
   - consequences: direct follow-up commitments or outcomes explicitly tied to this decision — omit key if none stated
   - confidence: 0.9 if explicitly announced; 0.7 if clearly agreed upon; 0.5 if strongly leaning toward acceptance
4. attendees: extract from participant lists or names mentioned as speakers. Exclude "Zoom AI Companion" and bot names.
5. meetingDate: prefer the meeting's actual date/time from the body over the email arrival date.
6. summary: 2–4 sentences covering the main topics and outcomes. Omit (empty string) if the body is too sparse to summarise faithfully.
7. confidence (meeting-level): 0.3 if email is mostly boilerplate/short with no structure, 0.7 if moderately rich with clear sections, 0.9+ if fully structured Zoom AI Companion output with named sections.
8. Empty arrays and omitted keys are always preferred over invented content. Never fabricate names, tasks, or decisions.

Respond with ONLY valid JSON — no markdown fences, no explanation, no preamble:
{
  "meetingTitle": "string",
  "meetingDate": "ISO date string",
  "attendees": ["Full Name"],
  "summary": "2-4 sentence summary or empty string",
  "actionItems": [{"text": "string", "owner": "string or omit key", "dueDate": "string or omit key", "confidence": 0.8}],
  "decisions": [{"text": "string", "title": "short headline or omit", "decidedBy": "string or omit", "rationale": "string or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit, "confidence": 0.8}],
  "blockers": ["string"],
  "followUps": ["string"],
  "confidence": 0.8
}`;

  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateText({
      model: getTextModel(),
      maxOutputTokens: MAX_TOKENS.default,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    return parseExtract(text, metadata);
  } catch (err) {
    console.error(
      "[zoom-extract] extraction failed:",
      err instanceof Error ? err.message : err
    );
    return emptyExtract(metadata.subject, metadata.date);
  }
}
