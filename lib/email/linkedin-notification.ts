/**
 * lib/email/linkedin-notification.ts
 *
 * Tells a LinkedIn message notification apart from LinkedIn marketing.
 *
 * WHY THIS EXISTS. app/api/email/route.ts treats every linkedin.com sender as
 * marketing and drops it from the signals feed. That was the right call for
 * "People you may know" and job alerts, which is most of LinkedIn's volume — but
 * it took "X sent you a message" and "X wants to connect" with it, and those are
 * genuine relational signal of exactly the kind Basil exists to catch.
 *
 * DEFAULT IS SUPPRESSED. Unrecognised LinkedIn mail stays out of the feed, on
 * the grounds that LinkedIn sends far more marketing than signal and a wrong
 * "needs you" costs more than a missed digest. But an unrecognised kind is
 * LOGGED rather than silently binned, so a pattern this file does not yet know
 * shows up as a log line instead of as nothing at all.
 *
 * NOT YET VERIFIED AGAINST REAL SAMPLES. As of 2026-08-26 the connected mailbox
 * has never received any linkedin.com mail, so these patterns are written from
 * the shapes LinkedIn's transactional mail is known to take, not from observed
 * examples. The log line above is how they get corrected once real mail arrives.
 */

export type LinkedInKind = "message" | "invitation" | "mention" | "marketing" | "unknown";

export function isLinkedInSender(fromEmail: string): boolean {
  return /@([a-z0-9-]+\.)*linkedin\.com$/i.test((fromEmail ?? "").trim().toLowerCase());
}

/**
 * Marketing patterns are checked FIRST. LinkedIn's promotional subjects often
 * borrow the grammar of a notification ("See who viewed your profile") and the
 * cost of misclassifying an advert as a message is a false "needs you" — which
 * is the failure that erodes trust in the whole feed.
 */
const MARKETING = [
  /people you may know/i,
  /job alert|jobs? for you|new jobs?|hiring/i,
  /your network (has|is)|network update|weekly|daily digest|this week/i,
  /see who|profile views?|appeared in \d+ search/i,
  /trending|top (voices?|stories)|news(letter)?|premium|free (month|trial)|upgrade/i,
  /course|learning|skill assessment|webinar|event reminder/i,
  /congratulate|work anniversary|birthday/i,
];

const MESSAGE = [
  /sent you a message/i,
  /\bnew message\b/i,
  /replied to (you|your)/i,
  /^re:.*\bInMail\b/i,
  /\bInMail\b/i,
];

const INVITATION = [
  /invitation (to connect|from)/i,
  /wants to connect/i,
  /would like to connect/i,
  /\byour invitation\b/i,
  /accepted your invitation/i,
];

const MENTION = [
  /mentioned you/i,
  /tagged you/i,
  /commented on your/i,
  /reacted to your/i,
];

export function classifyLinkedInEmail(fromEmail: string, subject: string): LinkedInKind {
  if (!isLinkedInSender(fromEmail)) return "unknown";
  const s = (subject ?? "").trim();
  const local = (fromEmail.split("@")[0] ?? "").toLowerCase();

  // Local-part is the strongest signal LinkedIn gives, and it does not depend on
  // subject-line copy, which they change constantly.
  if (/^(jobs|job-alerts|jobs-listings|news|updates|notifications?|learning|education|premium|marketing)/.test(local)) {
    return "marketing";
  }
  if (MARKETING.some((r) => r.test(s))) return "marketing";

  if (/^(messag|inmail)/.test(local) || MESSAGE.some((r) => r.test(s))) return "message";
  if (/^invit/.test(local) || INVITATION.some((r) => r.test(s))) return "invitation";
  if (MENTION.some((r) => r.test(s))) return "mention";

  return "unknown";
}

/** True when this LinkedIn mail is a real interpersonal signal worth surfacing. */
export function isActionableLinkedIn(fromEmail: string, subject: string): boolean {
  const kind = classifyLinkedInEmail(fromEmail, subject);
  if (kind === "unknown" && isLinkedInSender(fromEmail)) {
    // Visible gap, not a silent one — this is how the patterns above get fixed.
    console.info(
      `[linkedin] unrecognised notification kind from=${fromEmail} subject="${(subject ?? "").slice(0, 80)}"`,
    );
  }
  return kind === "message" || kind === "invitation" || kind === "mention";
}
