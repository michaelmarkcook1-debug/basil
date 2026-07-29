// Pulls Zoom AI Companion post-meeting summaries from Gmail + Drive.
//
// Zoom sends meeting recap emails from @zoom.us ("Zoom AI Companion",
// "Meeting Summary from Zoom"). When a host saves a recording to Drive,
// it shows up as a Google Doc with "Zoom" in the title and a transcript/
// summary inside.
//
// We fetch both so meeting prep can carry in what was said on prior calls
// — without this, Basil hallucinates around gaps where the real answer is
// sitting in Michael's inbox.

import { searchEmails, getEmailBody } from "./gmail";
import { searchDriveFiles } from "./drive";
import { ZOOM_GMAIL_QUERY, ZOOM_FORWARDED_GMAIL_QUERY, detectZoomEmail } from "./zoom-email-detector";

export interface ZoomSummary {
  /** "gmail" or "drive" — where we found it. */
  source: "gmail" | "drive";
  title: string;
  /** ISO timestamp. */
  date: string;
  /** The summary/transcript text. May be truncated. */
  body: string;
  /** Deep link into Gmail thread or Drive file. */
  link?: string;
}

// Canonical Zoom Gmail query lives in zoom-email-detector.ts (re-exported here for
// backward compatibility with any code that imports from zoom-summaries directly).
export { ZOOM_GMAIL_QUERY };

/** Strip HTML → text-ish. Not perfect; Zoom emails are mostly plain. */
function stripTags(s: string): string {
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

function clip(s: string, max = 2000): string {
  if (!s) return "";
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Strip any stack of leading "Fwd:"/"FW:" prefixes from a subject. */
function stripForwardPrefix(subject: string): string {
  return subject.replace(/^(\s*(?:fwd?|fw)\s*:\s*)+/i, "").trim();
}

/** Dedupe key for "same recap arriving twice" (direct + forwarded). */
function recapKey(subject: string, dateIso: string): string {
  return `${stripForwardPrefix(subject).toLowerCase().replace(/\s+/g, " ")}|${(dateIso || "").slice(0, 10)}`;
}

/** Gmail-side Zoom recaps from the last `days` days — direct AND forwarded. */
export async function getZoomSummariesFromGmail(username: string, days = 14, maxResults = 8): Promise<ZoomSummary[]> {
  try {
    // Two searches, not one: the canonical query is from:-restricted to Zoom's
    // domains, so a recap a colleague FORWARDS could never match it and was
    // invisible here. The forwarded query is looser (no sender restriction), so
    // its hits must additionally pass detectZoomEmail before being trusted.
    const [direct, forwarded] = await Promise.all([
      searchEmails(username, `${ZOOM_GMAIL_QUERY} newer_than:${days}d`, maxResults),
      searchEmails(username, `${ZOOM_FORWARDED_GMAIL_QUERY} newer_than:${days}d`, maxResults)
        .catch(() => []),
    ]);
    const directIds = new Set(direct.map((m) => m.id));
    const forwardedOnly = forwarded.filter((m) => !directIds.has(m.id));
    const messages = [
      ...direct.map((m) => ({ m, isForwarded: false })),
      ...forwardedOnly.map((m) => ({ m, isForwarded: true })),
    ];
    if (messages.length === 0) return [];

    // Pull full body for each — the summary is the whole point.
    const bodies = await Promise.all(
      messages.map(async ({ m, isForwarded }) => {
        try {
          const full = await getEmailBody(username, m.id);
          return { m, isForwarded, full };
        } catch {
          return { m, isForwarded, full: null };
        }
      })
    );

    const out: ZoomSummary[] = [];
    // Direct copies are processed first (see `messages` order), so when the
    // same recap arrived both directly and forwarded, the direct one wins the
    // dedupe slot and the forwarded duplicate is dropped.
    const seen = new Set<string>();
    for (const { m, isForwarded, full } of bodies) {
      if (!full) continue;
      const bodyText = stripTags(full.body || m.snippet || "");
      if (isForwarded) {
        // The looser query can catch non-Zoom mail (e.g. a forwarded Meet
        // recap). Only keep hits the multi-signal detector confirms.
        const signal = detectZoomEmail({ from: m.from, subject: m.subject, snippet: m.snippet, body: bodyText });
        if (!signal.isZoom) continue;
      }
      const key = recapKey(m.subject || "", m.date);
      if (seen.has(key)) continue;
      seen.add(key);
      const cleanTitle = stripForwardPrefix(m.subject || "") || "Zoom summary";
      out.push({
        source: "gmail" as const,
        // Keep the forwarder visible — "who shared this with me" is real
        // context for the model without needing a schema change downstream.
        title: isForwarded ? `${cleanTitle} (forwarded by ${m.from})` : cleanTitle,
        date: m.date,
        body: clip(bodyText),
      });
    }
    return out;
  } catch (e) {
    console.error("getZoomSummariesFromGmail error:", e);
    return [];
  }
}

/** Drive-side: Google Docs whose title suggests they're Zoom recordings or
 *  summaries. Bodies aren't fetched — just surface the title + link. */
export async function getZoomDocsFromDrive(username: string, maxResults = 5): Promise<ZoomSummary[]> {
  try {
    const files = await searchDriveFiles(username, "Zoom", maxResults);
    return files
      .filter((f) => /zoom/i.test(f.name))
      .map((f) => ({
        source: "drive" as const,
        title: f.name,
        date: f.modifiedDate || new Date().toISOString(),
        body: `Drive doc — open to read transcript/summary.`,
        link: f.webViewLink,
      }));
  } catch (e) {
    console.error("getZoomDocsFromDrive error:", e);
    return [];
  }
}

/** Combined fetch. Returns sorted newest-first. */
export async function getZoomSummaries(username: string, days = 14): Promise<ZoomSummary[]> {
  const [gmail, drive] = await Promise.all([
    getZoomSummariesFromGmail(username, days),
    getZoomDocsFromDrive(username),
  ]);
  return [...gmail, ...drive].sort((a, b) => b.date.localeCompare(a.date));
}

/** Filter summaries to ones whose body or title mentions any of the given
 *  attendee names (case-insensitive, first-name match included). */
export function filterByAttendees(
  summaries: ZoomSummary[],
  attendeeNames: string[]
): ZoomSummary[] {
  if (attendeeNames.length === 0) return summaries;
  const needles = attendeeNames.flatMap((n) => {
    const lower = n.toLowerCase();
    const parts = lower.split(/\s+/).filter((p) => p.length > 2);
    return [lower, ...parts];
  });
  return summaries.filter((s) => {
    const hay = `${s.title} ${s.body}`.toLowerCase();
    return needles.some((n) => hay.includes(n));
  });
}
