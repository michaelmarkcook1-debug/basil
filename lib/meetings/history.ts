/**
 * lib/meetings/history.ts — a permanent record of every meeting, by person.
 *
 * Audit 2026-11-24, item 3: meeting summaries were saved as "context"
 * memories that expire after 7 days, with no person attached — so meeting
 * prep's "what do we know about Jane" never found them, and a meeting from
 * last month was simply gone. Now each processed meeting (Zoom recap, Zoom
 * API, Read AI, Plaud, uploaded recording) is also kept here, once, for good:
 * date, attendees (names and, where known, emails), summary, topics,
 * decisions, actions with owners, and open questions.
 *
 * `meetingsWith` gives the running history with a person (or several), newest
 * first — for meeting prep, contact profiles and Ask Basil.
 *
 * One per-user file, `meeting-history.json`, capped at the newest 3,000.
 * The record functions are server-side; the matching is pure.
 */

export interface MeetingRecord {
  /** The source reference (gmail:…, zoom-api:…, upload:…). Unique per meeting. */
  id: string;
  /** "Zoom meeting", "Recording", "Read AI meeting", "Plaud recording"… */
  source: string;
  title: string;
  /** ISO date-time the meeting happened. */
  date: string;
  attendees: string[];
  attendeeEmails: string[];
  summary: string;
  topics: string[];
  decisions: string[];
  actions: Array<{ text: string; owner?: string }>;
  openQuestions: string[];
  recordedAt: string;
}

export interface PersonQuery { names?: readonly string[]; emails?: readonly string[] }

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}@.\s-]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Does this attendee name stand for one of the people asked about? Whole-name
 * equality, or the same first and last name ("Jane Doe" ≈ "Jane A. Doe").
 * A bare first name matches only a bare first name — "Jane" alone must not
 * claim every Jane.
 */
export function sameName(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.split(" "), ys = y.split(" ");
  if (xs.length < 2 || ys.length < 2) return false;
  return xs[0] === ys[0] && xs[xs.length - 1] === ys[ys.length - 1];
}

export function involves(m: Pick<MeetingRecord, "attendees" | "attendeeEmails">, q: PersonQuery): boolean {
  const emails = new Set((q.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (m.attendeeEmails.some((e) => emails.has(e.toLowerCase()))) return true;
  const names = (q.names ?? []).filter((n) => n.trim().length >= 2);
  return m.attendees.some((a) => names.some((n) => sameName(a, n)));
}

/** Meetings with any of these people, newest first. */
export function meetingsWith(history: readonly MeetingRecord[], q: PersonQuery, limit = 10): MeetingRecord[] {
  return history.filter((m) => involves(m, q)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Meetings as a prompt block: what was discussed, decided and left to do. */
export function historyBlock(ms: readonly MeetingRecord[], opts: { summaryChars?: number } = {}): string {
  return ms.map((m) => {
    const lines = [
      `- ${m.date.slice(0, 10)} · ${m.source} · "${m.title}"${m.attendees.length ? ` · with ${m.attendees.slice(0, 8).join(", ")}` : ""}`,
      m.summary ? `  Summary: ${clip(m.summary.replace(/\s+/g, " "), opts.summaryChars ?? 600)}` : "",
      m.decisions.length ? `  Decided: ${m.decisions.slice(0, 4).map((d) => clip(d, 160)).join("; ")}` : "",
      m.actions.length ? `  Actions: ${m.actions.slice(0, 5).map((a) => `${a.owner ? `${a.owner}: ` : ""}${clip(a.text, 140)}`).join("; ")}` : "",
      m.openQuestions.length ? `  Open: ${m.openQuestions.slice(0, 3).map((q) => clip(q, 140)).join("; ")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n");
}

/**
 * What this person said, from a speaker-labelled transcript ("Jane Doe: …"
 * lines, as Read AI, Plaud and Basil's own transcripts store them). Their own
 * words — the strongest evidence of how someone communicates. Pure.
 */
export function spokenBy(lines: ReadonlyArray<{ text: string }>, name: string, max = 12): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const m = /^([^:]{2,60}):\s*(.+)$/.exec(l.text.trim());
    if (!m || !sameName(m[1], name)) continue;
    const said = m[2].trim();
    if (said.split(/\s+/).length < 4) continue; // "Yes." / "Thanks." say nothing about style
    out.push(said.length > 400 ? `${said.slice(0, 399)}…` : said);
    if (out.length >= max) break;
  }
  return out;
}
