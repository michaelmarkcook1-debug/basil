/**
 * lib/meetings/follow-up-shape.ts — which meetings get a follow-up email
 * drafted, and the prompt for it (audit 2026-11-24, Part 3 entry 13). Pure;
 * lib/meetings/follow-up.ts drafts and queues it.
 *
 * A recorded meeting (Zoom, Read AI, Plaud, an upload) with someone from
 * outside the user's company, under 36 hours old, with something to recap
 * (decisions, actions or a summary), gets one recap email drafted to the
 * outside attendees. It waits in the approvals queue; nothing is sent until
 * the user approves it.
 */
import type { MeetingRecord } from "@/lib/meetings/history";

export const MAX_AGE_MS = 36 * 3_600_000;

const domainOf = (e: string) => e.split("@")[1]?.trim().toLowerCase() ?? "";

/** The outside attendees' addresses — the people the follow-up goes to. */
export function followUpRecipients(rec: Pick<MeetingRecord, "attendeeEmails">, ownDomains: ReadonlySet<string>): string[] {
  return [...new Set(rec.attendeeEmails.map((e) => e.trim().toLowerCase()).filter((e) => {
    const d = domainOf(e);
    return d && !ownDomains.has(d) && !/calendar\.google\.com$|zoom\.us$|read\.ai$|plaud\.ai$|noreply|no-reply/.test(e);
  }))];
}

export function wantsFollowUp(rec: MeetingRecord, ownDomains: ReadonlySet<string>, now = Date.now()): boolean {
  const t = Date.parse(rec.date);
  if (!Number.isFinite(t) || now - t > MAX_AGE_MS || t > now + 3_600_000) return false;
  if (!followUpRecipients(rec, ownDomains).length) return false;
  return rec.decisions.length > 0 || rec.actions.length > 0 || rec.summary.trim().length >= 80;
}

export function followUpPrompt(rec: MeetingRecord, firstName: string, recipients: readonly string[], style: string): string {
  const list = (xs: readonly string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "(none)");
  return `Write the follow-up email ${firstName} sends after this meeting, to: ${recipients.join(", ")}.

MEETING: ${rec.title} (${rec.date.slice(0, 10)}; ${rec.source})
ATTENDEES: ${rec.attendees.join(", ") || "(not listed)"}
SUMMARY: ${rec.summary || "(none)"}
DECISIONS:
${list(rec.decisions)}
ACTIONS (owner if known):
${list(rec.actions.map((a) => (a.owner ? `${a.text} — ${a.owner}` : a.text)))}
OPEN QUESTIONS:
${list(rec.openQuestions)}

Rules:
- A short thank-you line, then what was agreed, then who does what by when (owner and date where the notes give them; never invent a date or an owner — write "owner to confirm" instead), then any open question.
- Use only what is above. Nothing internal or sensitive that the outside attendees should not see (pricing margins, internal opinions of them, other clients).
- Plain text, short bullets, no headings, no subject line. Greeting and sign-off included, signed ${firstName}.
- Under 180 words.
${style ? `\n${style}\n` : ""}`;
}
