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

const GMAIL_ZOOM_QUERY =
  'from:(zoom.us OR no-reply@zoom.us OR meeting-summary@zoom.us) (subject:"meeting summary" OR subject:"AI Companion" OR subject:"Zoom" OR subject:"Smart Summary")';

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

/** Gmail-side Zoom recaps from the last `days` days. */
export async function getZoomSummariesFromGmail(days = 14, maxResults = 8): Promise<ZoomSummary[]> {
  try {
    const query = `${GMAIL_ZOOM_QUERY} newer_than:${days}d`;
    const messages = await searchEmails(query, maxResults);
    if (messages.length === 0) return [];

    // Pull full body for each — the summary is the whole point.
    const bodies = await Promise.all(
      messages.map(async (m) => {
        try {
          const full = await getEmailBody(m.id);
          return { m, full };
        } catch {
          return { m, full: null };
        }
      })
    );

    return bodies
      .filter((b) => b.full)
      .map(({ m, full }) => ({
        source: "gmail" as const,
        title: m.subject || "Zoom summary",
        date: m.date,
        body: clip(stripTags(full!.body || m.snippet || "")),
      }));
  } catch (e) {
    console.error("getZoomSummariesFromGmail error:", e);
    return [];
  }
}

/** Drive-side: Google Docs whose title suggests they're Zoom recordings or
 *  summaries. Bodies aren't fetched — just surface the title + link. */
export async function getZoomDocsFromDrive(maxResults = 5): Promise<ZoomSummary[]> {
  try {
    const files = await searchDriveFiles("Zoom", maxResults);
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
export async function getZoomSummaries(days = 14): Promise<ZoomSummary[]> {
  const [gmail, drive] = await Promise.all([
    getZoomSummariesFromGmail(days),
    getZoomDocsFromDrive(),
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
