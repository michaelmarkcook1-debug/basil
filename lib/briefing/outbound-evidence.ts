import "server-only";

/**
 * lib/briefing/outbound-evidence.ts
 *
 * WHAT MICHAEL DID — the half of the story Basil could never see.
 *
 * The briefing's email feed is `in:inbox` only (lib/google/gmail.ts). That was a
 * deliberate choice — it stops the user's own sent mail being ingested and
 * misclassified as an inbound signal — but it left a structural blind spot:
 * **Basil could see problems arrive and never see the user solve them.**
 *
 * The failure it produced, verbatim from a real brief:
 *
 *   "BLOCKERS — Kyndryl pricing is sitting on your desk, not Ed's. […] Six days
 *    later there's no revised sheet and no logged decision."
 *
 * Michael had in fact sorted the pricing, emailed the deck to Olivia, and told
 * Ed it was handled. Every one of those is an OUTBOUND event, so the briefing
 * was structurally incapable of observing any of them. Being wrong in that
 * direction is expensive: it burns attention on settled work and quietly erodes
 * trust in every other line of the brief.
 *
 * This module assembles the missing side. It is deliberately used ONLY to
 * resolve items the briefing would otherwise assert as blocked — never as a
 * source of new actions, commitments or signals — which preserves the original
 * reason for the inbox-only restriction.
 */

/** One thing the user said or sent. */
export interface OutboundEvent {
  /** "email" | "slack" */
  channel: "email" | "slack";
  /** Who it went to (recipient, or channel name). */
  to: string;
  /** Subject line or the leading text of the message. */
  subject: string;
  /** Body/snippet text used for completion detection. */
  text: string;
  /** ISO timestamp. */
  at: string;
  /**
   * True when the user EXPLICITLY stated the thing is finished — "sorted",
   * "done", "sent it over", "handled". This is the difference between
   * "in flight, awaiting reply" and "closed": an explicit statement of
   * completion resolves an item outright, whereas merely having sent something
   * only means it is in flight.
   */
  explicitlyDone: boolean;
}

/**
 * Phrases where the user asserts completion.
 *
 * Deliberately requires a PAST or PERFECT form. "I'll send it over" and "going
 * to sort that tomorrow" are commitments, not completions — treating them as
 * done would recreate the original bug in the opposite direction, silently
 * closing work that has not happened.
 */
const DONE_PATTERNS: RegExp[] = [
  /\b(?:i've|i have|just|now)\s+(?:sorted|sent|shared|handled|resolved|finished|completed|actioned|done)\b/i,
  /\b(?:sorted|handled|resolved|actioned)\s+(?:it|this|that|now)\b/i,
  /\b(?:it's|thats|that's|this is|all)\s+(?:sorted|done|handled|sent|resolved|finished|complete[d]?)\b/i,
  /\b(?:sent|shared|sending)\s+(?:it|this|that|the deck|the sheet|the list|over|across|through)\b/i,
  /\bhas been (?:sent|shared|sorted|handled|resolved|completed)\b/i,
  /\btaken care of\b/i,
  /\bclosed (?:this |that |it )?out\b/i,
  /\bwrapped (?:this |that |it )?up\b/i,
  /\bno longer (?:blocked|blocking|an issue)\b/i,
];

/** Future/intent markers that DISQUALIFY a completion match on the same text. */
const FUTURE_PATTERNS: RegExp[] = [
  /\b(?:i'll|i will|going to|gonna|planning to|need to|should|about to|once i|when i)\b/i,
  /\b(?:tomorrow|later today|next week|shortly|in a bit|by (?:friday|monday|eod|cob))\b/i,
];

/**
 * Does this text explicitly assert the work is finished?
 *
 * A future marker anywhere in the text vetoes the match — "I'll get that sorted
 * tomorrow" contains "sorted" but is a promise, not a completion.
 */
export function statesCompletion(text: string): boolean {
  if (!text) return false;
  if (FUTURE_PATTERNS.some((re) => re.test(text))) return false;
  return DONE_PATTERNS.some((re) => re.test(text));
}

/** Build an OutboundEvent from a sent email. */
export function fromSentEmail(msg: {
  to: string; subject: string; snippet: string; date: string;
}): OutboundEvent {
  return {
    channel: "email",
    to: msg.to || "unknown",
    subject: msg.subject || "(no subject)",
    text: msg.snippet ?? "",
    at: msg.date,
    // The subject carries intent too ("Revised Kyndryl pricing"), so check both.
    explicitlyDone: statesCompletion(`${msg.subject ?? ""} ${msg.snippet ?? ""}`),
  };
}

/** Build an OutboundEvent from one of the user's own Slack messages. */
export function fromOwnSlackMessage(msg: {
  channel?: string; text: string; ts?: string; date?: string;
}): OutboundEvent {
  return {
    channel: "slack",
    to: msg.channel ? `#${msg.channel}` : "Slack",
    subject: msg.text.slice(0, 80),
    text: msg.text,
    at: msg.date ?? msg.ts ?? "",
    explicitlyDone: statesCompletion(msg.text),
  };
}

/**
 * Render the outbound feed for the prompt.
 *
 * Items where the user stated completion are marked so the model can apply the
 * three-state rule without having to infer it from prose.
 */
export function formatOutboundBlock(events: OutboundEvent[], limit = 25): string {
  if (events.length === 0) {
    return "No outbound activity recorded in this window (no sent email, no messages from you).";
  }
  const sorted = [...events]
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, limit);

  return sorted
    .map((e) => {
      const when = e.at ? e.at.slice(0, 16).replace("T", " ") : "unknown time";
      const flag = e.explicitlyDone ? " [STATED COMPLETE]" : "";
      const body = e.text.slice(0, 200).replace(/\s+/g, " ").trim();
      return `- ${when} · ${e.channel} → ${e.to}${flag}\n  ${e.subject}\n  ${body}`;
    })
    .join("\n");
}
