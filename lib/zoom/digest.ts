/**
 * lib/zoom/digest.ts — the "Meeting Summaries — Calls You Didn't Host" digest.
 *
 * Zoom only emails AI Companion recaps to the meeting host, so calls the user
 * joins but does not host never reached Basil. The user set up a digest that
 * mails them (from their own alias) one section per such meeting:
 *
 *     TalentGenius GTM standup
 *     Host: Ed Baum | Date: 2026-10-21 18:29:19
 *     <summary paragraph>
 *
 * The digest covers a rolling 30 days, so the same meeting appears in many
 * digests: each section gets a stable id from its title + start time, and is
 * processed once.
 *
 * Pure: no I/O. poll-ingest finds the email; process-gmail-message turns each
 * meeting into actions, decisions and notes exactly as for a Zoom recap.
 */

import type { SelfIdentity } from "@/lib/self-identity";

export interface DigestMeeting {
  title: string;
  host: string;
  /** ISO timestamp of the meeting start (the digest's time, read as UTC). */
  date: string;
  summary: string;
  /** False when the summary is unusable (e.g. the generator printed its instructions). */
  usable: boolean;
}

/**
 * Gmail search for the digest. It arrives from the user's own alias, so the
 * regular email loop (which skips self-sent mail) never sees it; poll-ingest
 * fetches it with this query and confirms the sender with `isZoomDigest`.
 */
export const ZOOM_DIGEST_GMAIL_QUERY = 'subject:"Meeting Summaries" newer_than:31d';

const SUBJECT = /^\s*meeting summaries\b/i;

/** The digest is a "Meeting Summaries…" email the user sent themselves. */
export function isZoomDigest(
  email: { from: string; fromEmail?: string; subject: string },
  self: SelfIdentity,
): boolean {
  if (!SUBJECT.test(email.subject)) return false;
  const addr = (email.fromEmail || email.from.match(/<([^>]+)>/)?.[1] || email.from).trim().toLowerCase();
  return self.emails.includes(addr);
}

/** HTML or plain text → trimmed, non-empty lines, keeping block boundaries. */
export function digestLines(body: string): string[] {
  const text = /<[a-z][\s\S]*>/i.test(body)
    ? body
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|section|article|table)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&rsquo;|&#8217;/g, "’")
        .replace(/&lsquo;|&#8216;/g, "‘")
        .replace(/&ldquo;|&rdquo;/g, '"')
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
    : body;
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

/** Markdown bold and stray markers off a field: "**Host:** Ed" → "Host: Ed". */
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/^[>#\s-]+/, "").trim();

const HOST = /^host\s*:\s*(.+?)\s*(?:\|\s*date\s*:\s*(.+))?$/i;
const DATE = /^date\s*:\s*(.+)$/i;
const FOOTER = /^(?:unsubscribe|sent (?:by|from)|generated (?:by|with)|this (?:email|digest) was)/i;

/** "2026-10-21 18:29:19" → ISO. Unparseable → undefined. */
function isoOf(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (!m) return undefined;
  const iso = `${m[1]}T${m[2] ?? "00:00"}:${m[3] ?? "00"}Z`;
  return Number.isNaN(Date.parse(iso)) ? undefined : new Date(iso).toISOString();
}

/**
 * The generator sometimes returns its own instructions instead of a summary
 * ("We need summarize 3-5 sentences, topics decisions actions… Concise.").
 * Feeding that to extraction would invent actions, so such sections are kept
 * as a meeting record but not mined.
 */
export function looksLikeLeakedPrompt(summary: string): boolean {
  const s = summary.trim();
  if (s.length < 40) return true;
  if (/^(?:we|i)\s+(?:need|should|must|will|have)\s+(?:to\s+)?summari[sz]e\b/i.test(s)) return true;
  if (/\bsummari[sz]e\b.{0,40}\b\d+\s*[-–]\s*\d+\s+sentences\b/i.test(s)) return true;
  return false;
}

/** Split a digest body into its meetings, in the order they appear. */
export function parseZoomDigest(body: string): DigestMeeting[] {
  const lines = digestLines(body).map(plain);
  const out: DigestMeeting[] = [];
  const hostAt: number[] = [];
  lines.forEach((l, i) => { if (HOST.test(l)) hostAt.push(i); });

  hostAt.forEach((h, k) => {
    const m = lines[h].match(HOST)!;
    const host = m[1].trim();
    let dateRaw = m[2];
    let bodyStart = h + 1;
    if (!dateRaw && DATE.test(lines[h + 1] ?? "")) {
      dateRaw = lines[h + 1].match(DATE)![1];
      bodyStart = h + 2;
    }
    const date = dateRaw ? isoOf(dateRaw) : undefined;
    const title = h > 0 ? lines[h - 1] : "";
    // The summary runs to the next section's title (the line before its Host line).
    const end = k + 1 < hostAt.length ? hostAt[k + 1] - 1 : lines.length;
    const summaryLines: string[] = [];
    for (let i = bodyStart; i < end; i++) {
      if (FOOTER.test(lines[i])) break;
      summaryLines.push(lines[i]);
    }
    const summary = summaryLines.join("\n").trim();
    if (!title || !host || !date) return;
    out.push({ title, host, date, summary, usable: !looksLikeLeakedPrompt(summary) });
  });
  return out;
}

/** Stable id per meeting, the same in every digest that repeats it. */
export function digestMeetingRef(m: Pick<DigestMeeting, "title" | "date">): string {
  const slug = m.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `zoom-digest:${m.date.slice(0, 16)}:${slug}`;
}

/** The text extraction reads: the same shape as a recap, host named as an attendee. */
export function digestMeetingText(m: DigestMeeting): string {
  return `Meeting: ${m.title}\nHost: ${m.host}\nDate: ${m.date.slice(0, 10)}\nMeeting participants: ${m.host}\n\nSummary:\n${m.summary}`;
}

/**
 * A meeting title as Zoom's own recap emails phrase it, reduced to its words:
 * "Fwd: Meeting assets for NH Acquisition are ready!" → "nh acquisition".
 */
export function recapMeetingTitle(subject: string): string {
  return subject
    .replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "")
    .replace(/^meeting assets for\s+/i, "")
    .replace(/\s+are ready!?\s*$/i, "")
    .replace(/^meeting summary (?:with ai companion )?(?:for|of)\s+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when Zoom already mailed a recap for this meeting (the user hosted it),
 * so the digest copy would be a duplicate. Same title, recap seen from a day
 * before the meeting to three days after (recaps are ingested at sync time).
 */
export function coveredByHostedRecap(
  m: Pick<DigestMeeting, "title" | "date">,
  recaps: Array<{ title: string; at: string }>,
): boolean {
  const want = recapMeetingTitle(m.title);
  if (!want) return false;
  const t = Date.parse(m.date);
  return recaps.some((r) => {
    if (recapMeetingTitle(r.title) !== want) return false;
    const at = Date.parse(r.at);
    return at >= t - 86_400_000 && at <= t + 3 * 86_400_000;
  });
}

/**
 * A meeting booked under an address outside the user's own domains (e.g. a
 * personal Gmail in the title) is personal, not work: Basil leaves it out.
 */
export function isPersonalMeeting(m: Pick<DigestMeeting, "title">, self: SelfIdentity): boolean {
  const own = new Set(self.emails.map((e) => e.split("@")[1]).filter(Boolean));
  const addrs = m.title.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [];
  return addrs.some((a) => !own.has(a.split("@")[1]));
}

/**
 * Backfilled meetings older than this add context only — notes, decisions and
 * who was there — not open actions: three-week-old "will do X" items are
 * mostly done, and would bury the live list.
 */
export const DIGEST_ACTION_WINDOW_DAYS = 7;
export function digestNotesOnly(m: Pick<DigestMeeting, "date">, now = Date.now()): boolean {
  return now - Date.parse(m.date) > DIGEST_ACTION_WINDOW_DAYS * 86_400_000;
}
