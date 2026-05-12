/**
 * Pulls Read.ai post-meeting summaries from Gmail.
 *
 * Read.ai (read.ai) is an AI meeting assistant that sends automated
 * post-meeting recap emails containing action items, key topics, and
 * a transcript preview. These are high-signal for briefing and meeting
 * prep — they carry what was actually said in prior calls.
 *
 * We search Gmail for Read.ai summary emails and fetch the full body so
 * the briefing LLM can cross-reference attendees with today's calendar.
 */

import { searchEmails, getEmailBody } from "./gmail";

export interface ReadSummary {
  title: string;
  /** ISO timestamp. */
  date: string;
  /** Extracted summary text. May be truncated to 2000 chars. */
  body: string;
  /** Gmail message ID — for deduplication. */
  messageId: string;
}

/**
 * Gmail query covering all known Read.ai sender addresses and subject patterns.
 *
 * Read.ai sends from @read.ai variants, occasionally with subject prefixes like
 * "Read meeting recap", "Meeting Summary –", or "Your notes from…".
 */
export const READ_GMAIL_QUERY =
  "from:(read.ai OR noreply@read.ai OR notifications@read.ai OR " +
  "no-reply@read.ai OR hello@read.ai OR summaries@read.ai OR " +
  '"Read Assistant") ' +
  '(subject:"meeting" OR subject:"recap" OR subject:"summary" OR ' +
  'subject:"notes" OR subject:"read.ai" OR subject:"action items" OR ' +
  'subject:"Read Assistant")';

/** Strip HTML to plain text. Read.ai emails are HTML-heavy. */
function stripTags(s: string): string {
  return s
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function clip(s: string, max = 2000): string {
  if (!s) return "";
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Fetch Read.ai meeting summaries from Gmail for the last `days` days.
 *
 * Returns up to `maxResults` summaries sorted newest-first (Gmail default).
 */
export async function getReadSummariesFromGmail(
  username: string,
  days = 7,
  maxResults = 6
): Promise<ReadSummary[]> {
  try {
    const query = `${READ_GMAIL_QUERY} newer_than:${days}d`;
    const messages = await searchEmails(username, query, maxResults);
    if (messages.length === 0) return [];

    // Fetch full body for each — the summary content is the whole point
    const withBodies = await Promise.all(
      messages.map(async (m) => {
        try {
          const full = await getEmailBody(username, m.id);
          return { m, full };
        } catch {
          return { m, full: null };
        }
      })
    );

    return withBodies
      .filter((b) => b.full)
      .map(({ m, full }) => ({
        title: m.subject || "Read.ai meeting summary",
        date: m.date,
        body: clip(stripTags(full!.body || m.snippet || "")),
        messageId: m.id,
      }));
  } catch (err) {
    console.error("[read-summaries] getReadSummariesFromGmail error:", err);
    return [];
  }
}
