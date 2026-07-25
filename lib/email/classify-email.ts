/**
 * Proactive email intelligence classifier.
 *
 * Takes a plain-text email body + envelope metadata and produces structured
 * intelligence: category, confidence, extracted actions/decisions/people.
 *
 * Design:
 * - AI-powered with conservative extraction (explicit content only)
 * - Never fabricates — returns empty arrays rather than invented items
 * - Never throws — returns a low-confidence result on any failure
 * - Body clipped to 4 000 chars to keep AI costs bounded
 */

import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { EmailIntelligenceSchema } from "@/lib/ai/schemas";
import { getFlags } from "@/core/feature-flags";
import { getSettings } from "@/lib/settings/store";

// ── Category types ─────────────────────────────────────────────────────────────

export type EmailCategory =
  | "action_required"     // Sender is explicitly asking Michael to do something
  | "decision_request"    // Sender is asking Michael to make a decision or give approval
  | "decision_made"       // Email announces/confirms a decision that was reached
  | "follow_up_needed"    // Thread that Michael should actively follow up on
  | "relationship_signal" // Significant update about a contact, account, or business relationship
  | "scheduling_signal"   // Meeting request, availability question, calendar coordination
  | "informational_only"  // FYI update with no response or action needed
  | "low_value_noise";    // Newsletter, auto-notification, marketing, noreply, OOO, spam

export type EmailUrgency = "high" | "medium" | "low";

// ── Extracted types ────────────────────────────────────────────────────────────

export interface EmailPerson {
  name: string;
  role?: string;
}

export interface EmailAction {
  text: string;
  dueDate?: string;
  /** ISO timestamp when this action automatically expires (time-relative messages only). */
  expiresAt?: string;
  /** Urgency of this specific action item. */
  priority?: "high" | "medium" | "low";
}

export interface EmailDecision {
  text: string;
  /** Short (≤8 word) scannable headline. */
  title?: string;
  decidedBy?: string;
  /** Why this decision was made — only if explicitly stated. */
  rationale?: string;
  /** Alternatives explicitly mentioned as considered. */
  alternatives?: string[];
  /** Direct follow-up commitments tied to this decision. */
  consequences?: string[];
}

// ── Intelligence output ────────────────────────────────────────────────────────

export interface ToneShift {
  /** Name of the person whose tone shifted. */
  person: string;
  /** Direction relative to typical communication with this person. */
  direction: "warming" | "cooling" | "neutral";
  /** 1-sentence description of the observed shift. */
  summary: string;
}

export interface EmailIntelligence {
  category: EmailCategory;
  /** 0–1 — confidence in the category and extracted items. */
  confidence: number;
  urgency: EmailUrgency;
  /** Explicit action items addressable to the user. */
  actions: EmailAction[];
  /** Explicit decisions reported in the email. */
  decisions: EmailDecision[];
  /** People explicitly mentioned with roles if determinable. */
  people: EmailPerson[];
  /** Company or account names mentioned. */
  companies: string[];
  /** Explicit deadlines, e.g. "EOD Friday", "1 Dec 2024". */
  deadlines: string[];
  /** Risks, blockers, or concerns explicitly raised. */
  blockers: string[];
  /**
   * 1–2 sentence context summary suitable for storage in memory.
   * Empty string if the email is too sparse or low-value.
   */
  keyContext: string;
  /**
   * Detected tone/attitude shifts. Only set for relationship_signal emails
   * where a notable change in warmth, engagement, or disposition is clearly
   * observable from the message language. Omit for routine communication.
   */
  toneShifts?: ToneShift[];
}

// ── Threshold constants ────────────────────────────────────────────────────────

/**
 * Minimum confidence to attempt email materialization.
 * Items between this floor and ACTION_CONFIDENCE.AUTO (0.60) are materialized
 * with needsReview=true. Items below this floor are discarded.
 *
 * This matches EMAIL_REVIEW_FLOOR from lib/trust/policy.
 */
export const MIN_MATERIALIZE_CONFIDENCE = 0.35;

/**
 * Categories whose outputs are written to stores when confidence meets the
 * minimum threshold.  `informational_only` is only materialized at >=0.8
 * and only if there are people/companies that give it relationship standing.
 * `low_value_noise` is never materialized.
 */
export const MATERIALIZE_CATEGORIES = new Set<EmailCategory>([
  "action_required",
  "decision_request",
  "decision_made",
  "follow_up_needed",
  "relationship_signal",
  "scheduling_signal",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────


function emptyIntelligence(): EmailIntelligence {
  return {
    category: "low_value_noise",
    confidence: 0,
    urgency: "low",
    actions: [],
    decisions: [],
    people: [],
    companies: [],
    deadlines: [],
    blockers: [],
    keyContext: "",
  };
}

function parseIntelligence(raw: string): EmailIntelligence {
  const result = parseAndValidate(raw, EmailIntelligenceSchema, "[classify-email]");
  if (result.ok) return result.data as EmailIntelligence;
  // On parse/validation failure fall through to emptyIntelligence() at call site
  throw new Error(result.error);
}

// ── Core classification function ───────────────────────────────────────────────

export interface ClassifyEmailInput {
  /** Username to scope the system prompt to. Required — no fallback. */
  username: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  body: string;
}

/**
 * Classify an email and extract structured intelligence.
 *
 * @param input  Email envelope + plain-text body (HTML already stripped).
 * @returns Structured EmailIntelligence. Never throws.
 */
export async function classifyEmail(
  input: ClassifyEmailInput
): Promise<EmailIntelligence> {
  const { subject, from, date, snippet, body, username } = input;

  if (!username) {
    console.error("[email-classify] username is required — refusing to classify without owner");
    return emptyIntelligence();
  }
  const userName = (await getSettings(username).catch((err) => { console.error("[email-classify] settings load failed:", err); return null; }))?.name ?? username;
  const userFirstName = userName.split(" ")[0];

  // Clip to 4 000 chars — enough for rich emails, bounded AI cost
  const bodyClip = (body || snippet || "").trim().slice(0, 4_000);

  if (!bodyClip) return emptyIntelligence();

  const prompt = `Classify this email and extract structured intelligence. \
The recipient is ${userName}, a business executive. The sender is ${from}.

IMPORTANT — message direction:
- The FROM field is the SENDER. ${userFirstName} is the RECIPIENT.
- Email bodies often contain quoted reply history (lines starting with ">", or preceded by "On [date], [name] wrote:"). That quoted content is from PREVIOUS messages and may include things ${userFirstName} wrote earlier.
- Classify based on the MOST RECENT (top) message only. Do NOT extract actions from quoted sections that ${userFirstName} themselves wrote — those are their past outgoing messages, not requests being made of them now.

FROM: ${from}
SUBJECT: ${subject}
DATE: ${date}
BODY:
${bodyClip}

Classification rules — follow these strictly:

1. category — choose exactly one:
   - action_required: sender explicitly asks ${userFirstName} to do something
   - decision_request: sender asks ${userFirstName} to decide or give approval
   - decision_made: email announces/confirms a decision that was reached
   - follow_up_needed: thread ${userFirstName} should actively follow up on
   - relationship_signal: significant update about a contact, account, or business relationship
   - scheduling_signal: meeting request, availability question, calendar coordination
   - informational_only: FYI update, no response or action needed
   - low_value_noise: newsletter, auto-notification, marketing, noreply, OOO, spam

2. confidence: 0.3 if sparse/ambiguous, 0.7 if clear signals, 0.9+ if explicit and detailed

3. urgency:
   - high: deadline within 24h, time-critical ask, escalation
   - medium: expected response within a few days
   - low: no urgency or purely informational

4. actions: only explicitly assigned or implied tasks for ${userFirstName} — not vague suggestions.
   Each action: text (required), dueDate, priority ("high"/"medium"/"low" — high if urgent/deadline-driven, low if no urgency)
   dueDate: format YYYY-MM-DD. ACTIVELY infer it whenever the ask is tied to ANY resolvable date:
   - an explicit deadline ("by 1 Dec", "EOD Friday" → resolve relative to the email DATE ${date})
   - a meeting/event date — for invitations and scheduling emails, dueDate = the EVENT date
   - relative phrases ("by next Tuesday", "before the end of the month" → resolve against ${date})
   Omit dueDate ONLY when the message contains no date signal at all. An undated action cannot be
   scheduled or surfaced as due — prefer a best-effort date over omission when a date is present.
   expiresAt: ISO timestamp when this action becomes irrelevant. ONLY set when the message contains time-relative language tied to a moment that will pass — e.g. "before the meeting in 30 minutes", "by end of day today", "this afternoon", "before the 2pm call", "in the next hour". Compute relative to the email DATE (${date}). Examples: "meeting in 30 mins" → DATE + 30 min; "by EOD" → DATEdate at T23:59:00Z; "before the 2pm call" → DATEdate at T14:00:00Z. Omit for vague or date-only deadlines (those go in dueDate instead).
5. decisions: for confirmed/announced decisions, extract:
   - text: the full decision as a sentence
   - title: short (≤8 word) scannable headline, only if you can form one cleanly — omit key otherwise
   - decidedBy: who confirmed it, only if named — omit key otherwise
   - rationale: the explicit reason given — omit key if not stated
   - alternatives: options explicitly named as rejected — omit key if none stated
   - consequences: direct follow-up commitments tied to this decision — omit key if none stated
6. people: only people explicitly named in the email body
7. companies: business or account names explicitly mentioned
8. deadlines: only explicit dates or timeframes mentioned
9. blockers: risks, problems, or concerns explicitly raised in the email
10. keyContext: 1–2 sentences capturing what matters, or "" if low_value_noise

11. toneShifts: ONLY for relationship_signal emails. Omit entirely for other categories.
    Detect a shift when the sender's language reveals a notable change in warmth, engagement,
    or disposition compared to what would be expected in a normal professional exchange.
    Signals of WARMING: unexpectedly warm opener/closer, enthusiasm, praise, gratitude beyond routine,
    offers of help unprompted, personal detail shared voluntarily.
    Signals of COOLING: unusually terse, curt, formal where informal was expected, lack of greeting,
    passive-aggressive language, withdrawal of previously offered help, notably shorter than usual.
    DO NOT flag routine professional emails as a tone shift. Only flag when the language clearly
    departs from baseline professional norms in one direction or the other.
    Each entry: person (the sender's name), direction ("warming"/"cooling"/"neutral"), summary (1 sentence).

Extract ONLY what is explicitly present. Never fabricate or infer.

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "category": "action_required",
  "confidence": 0.85,
  "urgency": "medium",
  "actions": [{"text": "string", "dueDate": "string or omit", "priority": "high|medium|low", "expiresAt": "ISO timestamp or omit"}],
  "decisions": [{"text": "string", "title": "string or omit", "decidedBy": "string or omit", "rationale": "string or omit", "alternatives": ["string"] or omit, "consequences": ["string"] or omit}],
  "people": [{"name": "string", "role": "string or omit"}],
  "companies": ["string"],
  "deadlines": ["string"],
  "blockers": ["string"],
  "keyContext": "1-2 sentences or empty string",
  "toneShifts": [{"person": "string", "direction": "warming|cooling|neutral", "summary": "string"}] or omit
}`;

  // Read flags outside the try block — failure to fetch flags must not block classification
  const flags = await getFlags(username).catch((err) => { console.error("[email-classify] flags load failed:", err); return null; });

  // ── dispatch_active: dispatcher is the authoritative AI call path (Week 7) ──
  // When enabled, dispatch() replaces generateText() as the primary call and
  // injects assembled intelligence context into the system prompt.
  // Falls back to the legacy path on any error — rollback is flag-flip only.
  if (flags && flags.dispatch_active) {
    try {
      const { buildIntelligenceContext } = await import("@/core/context/intelligence-context-builder");
      const { serializeContext } = await import("@/core/primitives/intelligence-context");
      const { dispatch } = await import("@/core/dispatch/dispatcher");

      const system = await getSystemPrompt(username);
      const ctx = await buildIntelligenceContext({ username, currentSignal: null, flags });
      const ctxText = serializeContext(ctx);
      const enrichedSystem = ctxText
        ? `${system}\n\n## Intelligence Context\n${ctxText}`
        : system;

      const { output } = await dispatch({
        username,
        intent: "classify_email",
        sourceRef: null,
        modelKind: "balanced", // CATEGORIZATION → mid tier
        system: enrichedSystem,
        prompt,
        schema: EmailIntelligenceSchema,
        schemaName: "EmailIntelligence",
        schemaDescription: "Structured intelligence extracted from an email",
        meter: { username, feature: "classify:email" },
      });

      return output as EmailIntelligence;
    } catch (err) {
      // Dispatch failure: log and fall through to legacy path below
      console.error(
        "[email-classify] dispatch_active failed, falling back to generateText:",
        err instanceof Error ? err.message : err
      );
    }
  }

  // ── Legacy path: generateText + optional dispatch_shadow trace ────────────
  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateTextSafe({
      // CATEGORIZATION → mid tier (deciding what an email IS).
      model: getTextModel("balanced"),
      maxOutputTokens: MAX_TOKENS.fast,
      system,
      messages: [{ role: "user", content: prompt }],
    }, "balanced", { username, feature: "classify:email" });

    const result = parseIntelligence(text);

    // dispatch_shadow: parallel trace — only when dispatch is not already primary
    if (flags?.dispatch_shadow && !(flags?.dispatch_active)) {
      void (async () => {
        try {
          const { dispatch } = await import("@/core/dispatch/dispatcher");
          await dispatch({
            username,
            intent: "classify_email",
            sourceRef: null,
            modelKind: "balanced", // CATEGORIZATION → mid tier
            system,
            prompt,
            schema: EmailIntelligenceSchema,
            schemaName: "EmailIntelligence",
            schemaDescription: "Structured intelligence extracted from an email",
            meter: { username, feature: "classify:email:shadow" },
          });
        } catch {
          // Shadow failures are intentionally silent — never surface to caller
        }
      })();
    }

    return result;
  } catch (err) {
    console.error(
      "[email-classify] classification failed:",
      err instanceof Error ? err.message : err
    );
    return emptyIntelligence();
  }
}

/**
 * Returns true if the intelligence result should trigger store materialization.
 * Low-value noise and low-confidence results are never materialized.
 */
export function shouldMaterialize(intel: EmailIntelligence): boolean {
  if (intel.category === "low_value_noise") return false;
  if (intel.confidence < MIN_MATERIALIZE_CONFIDENCE) return false;
  if (MATERIALIZE_CATEGORIES.has(intel.category)) return true;

  // informational_only: only when confident AND has named people/companies
  // that give it standing as a relationship signal worth storing.
  if (intel.category === "informational_only") {
    return (
      intel.confidence >= 0.8 &&
      (intel.people.length > 0 || intel.companies.length > 0) &&
      intel.keyContext.length > 0
    );
  }

  return false;
}
