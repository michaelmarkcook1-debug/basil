/**
 * lib/followups/invitation-rsvp.ts
 *
 * Answering a meeting invitation on the CALENDAR is answering the email.
 *
 * THE GAP THIS CLOSES
 * detectGmail's only "already handled" test is checkThreadForSentReply — did the
 * user SEND a message into this Gmail thread. Accepting a Zoom/Calendar invite
 * never puts a reply in that thread, so an invitation the user accepted days ago
 * keeps resurfacing as "Reply to <organiser>", climbing the urgency ranking as
 * it ages. Observed in production: "Reply to Malcolm Frank — Zoom meeting
 * invitation - AnalystGenius - Ascendion demo, 94h waiting", sitting in
 * CRITICAL · ACT NOW for a meeting already accepted on the calendar.
 *
 * This is the same blind spot as the outbound-evidence work: Basil sees the ask
 * arrive but not the user answering it, so it nags about settled work — which is
 * corrosive, because a nag list that is wrong is a nag list you stop reading.
 *
 * Pure module (no I/O) so the matching is exhaustively testable. Suppressing the
 * WRONG card hides a real request, so both halves are deliberately strict:
 *   1. the email must actually BE an invitation (not merely mention a meeting)
 *   2. a calendar event must share a DISTINCTIVE token with it AND carry an
 *      explicit RSVP. "needsAction" is not an answer — those still surface.
 */

/** Minimal calendar shape needed to decide whether an invite was answered. */
export interface InviteCalendarEvent {
  summary: string;
  /** ISO datetime. */
  start: string;
  myResponseStatus?: "accepted" | "declined" | "tentative" | "needsAction";
  attendees: string[];
}

export interface InvitationEmail {
  subject: string;
  snippet: string;
  /** Organiser display name / address, when known. */
  from?: string;
}

/**
 * Does this email announce a meeting invitation?
 *
 * Anchored on the phrasing invitation mails actually use, NOT on loose words
 * like "meeting" or "invite" — a colleague writing "can we get a meeting in?"
 * is a genuine request for a reply and must never be suppressed.
 */
const INVITATION_PATTERNS: RegExp[] = [
  /\bis inviting you to a scheduled zoom meeting\b/i,
  /\bzoom meeting invitation\b/i,
  /\bhas invited you to\b/i,
  /\byou(?:'ve| have| were)?\s+(?:been\s+)?invited\b/i,
  /^\s*invitation:\s/i,                    // Google Calendar: "Invitation: <title> @ …"
  /^\s*updated invitation:\s/i,
  /\bgoogle calendar\b[\s\S]{0,40}\binvitation\b/i,
  /\bmicrosoft teams meeting\b[\s\S]{0,60}\bjoin\b/i,
  /\baccepted:|\bdeclined:/i,              // RSVP receipts are never "awaiting reply"
];

export function isMeetingInvitationEmail(email: InvitationEmail): boolean {
  const hay = `${email.subject || ""}\n${email.snippet || ""}`;
  return INVITATION_PATTERNS.some((p) => p.test(hay));
}

// Words too generic to identify WHICH meeting. Mirrors resolve-calendar.ts's
// list — every meeting here is generically titled, so the discriminator has to
// be the counterparty or product name, never "demo"/"meeting"/"invitation".
const BOILERPLATE = new Set([
  "analystgenius", "talentgenius", "demo", "meeting", "invite", "invitation",
  "invited", "inviting", "scheduled", "zoom", "teams", "google", "calendar",
  "topic", "time", "join", "link", "click", "here", "with", "for", "from",
  "the", "and", "your", "this", "that", "will", "sent", "please", "when",
  "confirm", "attendance", "session", "sync", "call", "team", "updated",
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday",
  "eastern", "pacific", "central", "london", "http", "https", "zoomus",
]);

function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of (text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !BOILERPLATE.has(raw) && !/^\d+$/.test(raw)) out.add(raw);
  }
  return out;
}

function eventTokens(event: InviteCalendarEvent): Set<string> {
  const out = distinctiveTokens(event.summary);
  for (const a of event.attendees ?? []) {
    for (const t of distinctiveTokens(a)) out.add(t);
    const at = a.indexOf("@");
    if (at > -1) {
      for (const t of distinctiveTokens(a.slice(0, at))) out.add(t);
      const domain = a.slice(at + 1).split(".");
      if (domain[0] && domain[0].length >= 4 && !BOILERPLATE.has(domain[0])) out.add(domain[0]);
    }
  }
  return out;
}

/** Substring-tolerant overlap so "hitachi" matches "hitachids". */
function sharesDistinctiveToken(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) {
    if (b.has(x)) return true;
    if (x.length >= 5) {
      for (const y of b) {
        if (y.length >= 5 && (y.includes(x) || x.includes(y))) return true;
      }
    }
  }
  return false;
}

/** An RSVP that actually answers the invitation. needsAction does NOT. */
const ANSWERED = new Set(["accepted", "declined", "tentative"]);

/**
 * True when this invitation email has already been answered on the calendar.
 *
 * @returns the matching event when answered, otherwise null (so callers can log
 *          WHY a card was suppressed — silent suppression is how a wrong filter
 *          hides a real request).
 */
export function findAnsweringCalendarEvent(
  email: InvitationEmail,
  events: InviteCalendarEvent[],
): InviteCalendarEvent | null {
  if (!isMeetingInvitationEmail(email)) return null;

  const emailTokens = distinctiveTokens(
    `${email.subject || ""} ${email.snippet || ""} ${email.from || ""}`,
  );
  if (emailTokens.size === 0) return null; // no discriminator → never suppress

  for (const event of events) {
    if (!ANSWERED.has(event.myResponseStatus ?? "needsAction")) continue;
    if (!sharesDistinctiveToken(emailTokens, eventTokens(event))) continue;
    return event;
  }
  return null;
}
