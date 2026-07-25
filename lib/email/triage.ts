import "server-only";

/**
 * Deterministic, pre-LLM email triage.
 *
 * The ingestion pipeline previously created a durable BasilEvent for EVERY
 * inbound email and delegated junk-filtering entirely to the AI classifier — which
 * only deterministically drops *literally empty* bodies. So a blank "Test", a
 * no-reply notification, or a marketing blast all became events that surfaced in
 * the feed. This helper makes that judgement cheaply and deterministically BEFORE
 * an event is created, so obvious low-value mail never enters the system.
 *
 * Tuning ("aggressive" per user preference): suppresses empty/trivial mail,
 * no-reply/automated NOTIFICATIONS, and newsletters/marketing/digests — i.e. mail
 * that is unambiguously machine-generated. It deliberately does NOT suppress
 * ambiguous human business addresses (team@, info@, hello@, support@), since a real
 * person at a small company legitimately emails from those.
 */

// Local-parts that are unambiguously automated notification / no-reply senders.
const NOREPLY_LOCALPARTS = [
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply",
  "notification", "notifications", "notify", "alerts", "alert",
  "mailer", "mailer-daemon", "bounce", "bounces", "postmaster",
  "automated", "auto-confirm", "autoconfirm", "mailbot",
];

// Local-parts that are unambiguously marketing / bulk (suppressed in aggressive mode).
const MARKETING_LOCALPARTS = [
  "newsletter", "newsletters", "marketing", "promo", "promotions", "promotional",
  "deals", "offers", "digest", "campaign", "campaigns", "mailing", "broadcast",
];
// Boundary-aware matcher so "newsletter-weekly@" matches but "pmarketing@" /
// "jdeals@" (a real person whose local-part merely contains a token) does not.
const MARKETING_LOCAL_RE = new RegExp(`(^|[._-])(${MARKETING_LOCALPARTS.join("|")})([._-]|$)`);

// Domains that are essentially always transactional/marketing infrastructure.
const AUTOMATED_DOMAINS = [
  "mailchimp", "mailchimpapp.net", "sendgrid", "sendgrid.net", "substack.com",
  "mailgun", "amazonses.com", "sparkpostmail.com", "mailjet", "postmarkapp.com",
  "customeriomail.com", "sendinblue", "hubspotemail.net", "rsgsv.net", "mcsv.net",
  "klaviyomail.com", "cmail19.com", "cmail20.com", "mailerlite.com",
];

// Subject tells for marketing/bulk mail (aggressive but precise). Deliberately
// excludes bare "sale"/"deal"/"last chance"/"limited time" — those appear in
// genuine 1:1 contract/negotiation mail (this owner works in contracts), so they
// must NOT trigger a pre-event drop. Only unambiguous bulk-marketing phrasing.
const MARKETING_SUBJECT =
  /\bunsubscribe\b|\bnewsletter\b|\bwebinar\b|\b\d+%\s*off\b|\bflash sale\b|\bblack friday\b|\bcyber monday\b|🎉|🚀|💸/i;

// Trivial subjects that carry no actionable content when the body is empty.
const TRIVIAL_SUBJECT = /^(re:\s*|fwd:\s*)*(test|testing|ping|hi|hello|hey|hey there|\(no subject\))[\s!.…]*$/i;

export interface EmailTriageInput {
  from: string;
  fromEmail: string;
  subject: string;
  /** Snippet or body — whatever cheap text is available pre-fetch. */
  snippet: string;
}

export interface EmailTriageResult {
  lowValue: boolean;
  /** Why it was judged low-value (for logging/audit). */
  reason?: string;
}

/**
 * True (with a reason) when an email is low-value and should not become a signal.
 * Conservative on human business addresses; aggressive on machine/marketing mail.
 */
export function triageEmail(e: EmailTriageInput): EmailTriageResult {
  const email = (e.fromEmail || "").toLowerCase();
  const local = email.split("@")[0] ?? "";
  const domain = email.split("@")[1] ?? "";
  const name = (e.from || "").toLowerCase();
  const subj = (e.subject || "").trim();
  const body = (e.snippet || "").trim();

  // 1. Empty / contentless mail with a trivial subject (the blank "Test").
  if (body.length === 0 && (subj.length === 0 || TRIVIAL_SUBJECT.test(subj))) {
    return { lowValue: true, reason: "empty-or-trivial" };
  }

  // 2. No-reply / automated notification senders — never a real correspondent.
  if (NOREPLY_LOCALPARTS.some((k) => local.includes(k))) {
    return { lowValue: true, reason: "no-reply-sender" };
  }
  if (/no.?reply|do.?not.?reply/.test(name)) {
    return { lowValue: true, reason: "no-reply-name" };
  }

  // 3. Marketing / bulk infrastructure (aggressive).
  if (AUTOMATED_DOMAINS.some((d) => domain.includes(d))) {
    return { lowValue: true, reason: "bulk-domain" };
  }
  if (MARKETING_LOCAL_RE.test(local)) {
    return { lowValue: true, reason: "marketing-sender" };
  }
  if (MARKETING_SUBJECT.test(subj)) {
    return { lowValue: true, reason: "marketing-subject" };
  }
  // Only an unambiguous "newsletter" in the display name — NOT a bare "marketing"
  // substring, which drops real humans like "Sarah | Marketing at Acme".
  if (/\bnewsletter\b/.test(name)) {
    return { lowValue: true, reason: "marketing-name" };
  }

  return { lowValue: false };
}
