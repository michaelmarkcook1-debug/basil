/**
 * Basil AI Draft Generation Service
 *
 * Produces specific, context-aware reply drafts for ingest-path events (emails,
 * Slack messages) using the same model + system prompt as the chat assistant.
 *
 * Replaces the placeholder `generateDraftBody` that previously emitted a
 * generic "Thanks for this…" paragraph regardless of message content.
 *
 * Design principles:
 * - Reuse `getSystemPrompt()` — same persona, memory, and ground rules apply
 * - Fetch full email body when available (ingest only stores 200-char snippet)
 * - Fetch up to 3 recent exchanges with the sender to add thread context
 * - Surface a `caveat` field when context is thin — never invent missing facts
 * - Return the empty-string placeholder and a caveat on hard failure so the UI
 *   always has something to show rather than a silent blank
 */

import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { getSystemPrompt } from "@/lib/ai/system-prompt";
import { searchEmails, getEmailBody } from "@/lib/google/gmail";
import { findContactByName, getPersonaSummary } from "@/lib/contacts-lookup";
import type { BasilEvent } from "./types";

// ── Public interface ──────────────────────────────────────────────────────────

export interface DraftResult {
  /** The ready-to-send draft body. Empty string if generation failed entirely. */
  body: string;
  /**
   * Optional caveat for the UI:
   * - "No recent correspondence found — drafted from message content only."
   * - "Insufficient context to answer the specific question; Michael should fill in X."
   * - "Draft generation error: …"
   */
  caveat?: string;
  /** ISO timestamp. Always set — used to distinguish AI-generated from placeholder. */
  generatedAt: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Extract the Gmail message ID from a sourceRef like "gmail:1abc2def". */
function extractGmailId(sourceRef: string | undefined): string | null {
  if (!sourceRef?.startsWith("gmail:")) return null;
  return sourceRef.slice("gmail:".length) || null;
}

/** Extract the email address from strings like "Foo Bar <foo@bar.com>" or "foo@bar.com". */
function extractEmail(from: string | undefined): string | null {
  if (!from) return null;
  const match = from.match(/<([^>]+)>/) || from.match(/\S+@\S+\.\S+/);
  return match ? match[1] ?? match[0] : null;
}

/** Fetch the full body of a Gmail message, with a safe fallback. */
async function fetchFullEmailBody(username: string, sourceRef: string | undefined): Promise<string | null> {
  const gmailId = extractGmailId(sourceRef);
  if (!gmailId) return null;
  try {
    const msg = await getEmailBody(username, gmailId);
    return msg.body || null;
  } catch {
    return null;
  }
}

/**
 * Fetch up to N recent emails to/from `senderEmail` to give thread context.
 * Searches both incoming (from:) and outgoing (to:) so Michael's replies are
 * included — a one-sided search misses the most recent half of any exchange.
 * Uses snippets only (not full bodies) — enough to establish thread continuity.
 */
async function fetchRecentExchanges(
  username: string,
  senderEmail: string,
  limit = 3
): Promise<string> {
  try {
    const emails = await searchEmails(
      username,
      `(from:${senderEmail} OR to:${senderEmail})`,
      limit
    );
    if (emails.length === 0) return "";
    return emails
      .map((e) => `  - [${e.date}] ${e.subject}: ${e.snippet}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ── Persona tone guidance ─────────────────────────────────────────────────────

function getToneGuidance(_senderName: string | undefined): string {
  return "Professional, direct, and warm. Concise — 2–4 sentences unless the message requires more.";
}

// ── Core generator ────────────────────────────────────────────────────────────

/**
 * Generate a real AI draft reply for the given event.
 *
 * Never throws — returns a `caveat` and empty/minimal body on failure so the
 * UI always has something to show.
 */
export async function generateDraftForEvent(event: BasilEvent, username: string): Promise<DraftResult> {
  const now = new Date().toISOString();

  if (!username) {
    console.error("[drafter] username is required — refusing to generate draft without owner", { eventId: event.id });
    return { body: "", caveat: "Draft skipped — no user owner resolved.", generatedAt: now };
  }
  const payload = event.payload as {
    title?: string; body?: string; from?: string;
    channel?: string; hints?: Record<string, unknown>;
  } | undefined;

  const isEmail  = event.source === "email";
  const isSlack  = event.source === "slack";
  const from     = event.entityName ?? payload?.from ?? "Unknown sender";
  const channel  = payload?.channel;
  const subject  = event.draft?.subject ?? payload?.title ?? "";
  const snippetBody = payload?.body ?? event.context ?? "";

  // ── 1. Build context blocks ──────────────────────────────────────────────

  const caveats: string[] = [];

  // Full email body (much richer than the 200-char snippet stored in payload)
  let messageBody = snippetBody;
  if (isEmail) {
    const full = await fetchFullEmailBody(username, event.sourceRef);
    if (full) {
      messageBody = full;
    } else {
      caveats.push("Full email body unavailable — drafted from preview snippet only.");
    }
  }

  // Recent exchanges (thread context)
  let recentExchangesBlock = "";
  if (isEmail) {
    const senderEmail = extractEmail(from);
    if (senderEmail) {
      const exchanges = await fetchRecentExchanges(username, senderEmail);
      if (exchanges) {
        recentExchangesBlock = `\n\n## Recent exchanges with ${from}\n${exchanges}`;
      } else {
        caveats.push("No recent correspondence found — drafted from this message only.");
      }
    }
  }

  // Persona / tone
  const contact = findContactByName(from);
  let personaBlock = "";
  if (contact) {
    const summary = getPersonaSummary(contact);
    personaBlock = `\n\n## Sender profile (tone guidance only — not factual source)\n${summary}`;
  }

  const toneGuidance = getToneGuidance(from);

  // ── 2. Compose the prompt ────────────────────────────────────────────────

  const sourceLabel = isEmail
    ? `email${subject ? ` (subject: "${subject}")` : ""}`
    : isSlack
    ? `Slack message${channel ? ` in ${channel}` : ""}`
    : `${event.source} message`;

  const displayName = username.split(/[@._]/)[0] || username;
  const userPrompt = `You are drafting a reply to an incoming ${sourceLabel} on ${displayName}'s behalf.

## INCOMING MESSAGE
From: ${from}
${subject && isEmail ? `Subject: ${subject}\n` : ""}
${messageBody || "(message body unavailable)"}
${recentExchangesBlock}${personaBlock}

## DRAFTING INSTRUCTIONS
1. **Be specific** — address the actual content of this message. Do NOT produce a generic holding reply unless there is genuinely nothing to respond to yet.
2. **Evidence only** — only reference facts that are in the message above or in your persistent memory section. Never invent timelines, commitments, figures, or status updates.
3. **If you can't answer something** — write "Let me check on that and come back to you" rather than fabricating. Note what's missing in the caveat.
4. **Tone**: ${toneGuidance}
5. **Sign as**: "${displayName}" (first name only)
6. **Length**: Concise. 2–4 sentences for straightforward replies; a short paragraph or two for complex ones. No filler phrases like "Thanks for reaching out."

Respond with valid JSON only, no markdown fences:
{
  "body": "the complete draft reply, ready to send",
  "caveat": "optional — brief note if context was insufficient to draft with full confidence; omit this key if the draft is solid"
}

CRITICAL: The reply must address the specific content of THIS message. If you find yourself writing a generic placeholder, stop and re-read the message.`;

  // ── 3. Generate ──────────────────────────────────────────────────────────

  try {
    const system = await getSystemPrompt(username);
    const { text } = await generateTextSafe({
      model: getTextModel(),
      maxOutputTokens: MAX_TOKENS.default,
      system,
      messages: [{ role: "user", content: userPrompt }],
    }, "default", { username, feature: "draft" });

    // Parse the JSON response
    let parsed: { body?: string; caveat?: string } = {};
    try {
      // Strip any accidental markdown fences
      const cleaned = text.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      parsed = JSON.parse(cleaned);
    } catch {
      // If JSON parsing fails, use the raw text as the body
      parsed = { body: text.trim(), caveat: "Response was not in the expected JSON format — using raw text." };
    }

    const body = parsed.body?.trim() ?? "";
    const aiCaveat = parsed.caveat?.trim();

    // Merge pre-generation caveats (context gaps) with AI-expressed caveats
    const allCaveats = [...caveats, ...(aiCaveat ? [aiCaveat] : [])];

    if (!body) {
      return {
        body: "",
        caveat: ["AI produced an empty draft.", ...allCaveats].join(" "),
        generatedAt: now,
      };
    }

    return {
      body,
      caveat: allCaveats.length > 0 ? allCaveats.join(" ") : undefined,
      generatedAt: now,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      body: "",
      caveat: `Draft generation failed: ${errMsg}. Please compose manually.`,
      generatedAt: now,
    };
  }
}
