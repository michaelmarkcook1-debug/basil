import type {
  IngestPayload,
  BasilEvent,
  EventDisposition,
  EventPriority,
} from "./types";

// Default autonomy rules Michael approved:
// - Auto:   extract decisions/actions, update relationship tracker, update memory,
//           generate meeting prep, surface contact context for upcoming meetings.
// - Draft:  reply to emails, send Slack messages, schedule meetings.
// - Notify: money, legal, hiring/firing, @here in exec channels.

const MONEY_KEYWORDS = /\b(invoice|payment|payroll|salary|refund|budget|fundraise|term sheet|sign off|sign-off|cap table|equity|bank|wire|\$\s?[\d,]+|\d+k\b|\d+m\b)/i;
const LEGAL_KEYWORDS = /\b(legal|contract|nda|msa|subpoena|compliance|gdpr|breach|lawsuit|counsel|lawyer)/i;
const HIRING_KEYWORDS = /\b(hire|hiring|fired|firing|offer|termination|resign|notice|headcount|candidate|interview loop)/i;
const DECISION_KEYWORDS = /\b(decision|decided|approve|approval|ship|go\/no-go|sign off|green light)/i;
const ACTION_KEYWORDS = /\b(todo|to do|action|follow up|follow-up|action item|next step|owner:|due:)/i;

/** Fallback hardcoded list used when no dynamic contact set is available. */
const KEY_PEOPLE_FALLBACK = ["malcolm", "ed baum", " ed ", "isaac", "olivia", "sam jordan"];

/**
 * Returns true when `text` matches a known contact.
 *
 * When `dynamicNames` is provided (loaded from the contact store at runtime)
 * it takes precedence — every contact becomes a key person.  The hardcoded
 * fallback list is only used when the dynamic set is unavailable (e.g. unit
 * tests, legacy call sites).
 */
export function isAboutKeyPerson(text: string, dynamicNames?: Set<string>): boolean {
  const t = text.toLowerCase();
  if (dynamicNames && dynamicNames.size > 0) {
    // Check each token in the name set against the text
    for (const name of dynamicNames) {
      if (name && t.includes(name)) return true;
    }
    return false;
  }
  return KEY_PEOPLE_FALLBACK.some((p) => t.includes(p));
}

function detectTags(text: string): string[] {
  const tags: string[] = [];
  if (MONEY_KEYWORDS.test(text)) tags.push("money");
  if (LEGAL_KEYWORDS.test(text)) tags.push("legal");
  if (HIRING_KEYWORDS.test(text)) tags.push("hiring");
  if (DECISION_KEYWORDS.test(text)) tags.push("decision");
  if (ACTION_KEYWORDS.test(text)) tags.push("action");
  return tags;
}

interface Classification {
  disposition: EventDisposition;
  priority: EventPriority;
  rationale: string;
  tags: string[];
  draft?: BasilEvent["draft"];
  /** 0–1 rule confidence. 1.0 = definitive match, <1.0 = heuristic. */
  confidence: number;
}

export function classify(payload: IngestPayload): Classification {
  const combined = `${payload.title} ${payload.body}`;
  const tags = detectTags(combined);
  const isInvestor = !!payload.hints?.isFromInvestor;
  // Investor contacts (Ed, Malcolm) always get "investor" tag added
  if (isInvestor && !tags.includes("investor")) tags.push("investor");
  const aboutKeyPerson =
    payload.hints?.isFromKeyPerson || isAboutKeyPerson(combined);

  // 0) ZOOM EMAIL — always auto-classify; never draft a reply to a Zoom-generated email
  // The extraction service materializes actions/decisions separately; this event
  // is just the receipt record.
  if (payload.source === "zoom_email") {
    const zoomTags = [...new Set([...tags, "zoom", "meeting"])];
    return {
      disposition: "auto",
      priority: zoomTags.includes("action") || zoomTags.includes("decision") ? "normal" : "low",
      confidence: 1.0,
      rationale:
        "Zoom meeting summary — extracting action items, decisions, and notes now.",
      tags: zoomTags,
    };
  }

  // 1) NOTIFY — money / legal / hiring / @here in exec
  // Definitive keyword match → confidence 1.0
  const isHighStakes = ["money", "legal", "hiring"].some((t) => tags.includes(t));
  const isExecMention =
    payload.channel?.startsWith("#exec") && /@here|@channel/i.test(payload.body);

  if (isHighStakes || isExecMention) {
    return {
      disposition: "notify",
      priority: "high",
      confidence: 1.0,
      rationale: isExecMention
        ? "@here in #exec — you'd want to see this live, not from a summary."
        : `Matches high-stakes rule (${tags.filter((t) => ["money", "legal", "hiring"].includes(t)).join(", ")}). Not acting automatically.`,
      tags,
    };
  }

  // 2) DRAFT — incoming email/Slack that wants a reply
  // Explicit hints (isDM, isMention) are definitive; key-person proximity is heuristic.
  const hasExplicitHint =
    payload.hints?.isDM || payload.hints?.isGroupDM || payload.hints?.isMention;
  const isReplyable =
    (payload.source === "email" || payload.source === "slack") &&
    (hasExplicitHint || aboutKeyPerson);

  if (isReplyable) {
    const recipient = payload.fromEmail || payload.from || payload.channel || "recipient";
    return {
      disposition: "draft",
      priority: isInvestor ? "high" : aboutKeyPerson ? "high" : "normal",
      confidence: hasExplicitHint ? 1.0 : 0.8,
      rationale: `Drafting a reply — ${payload.hints?.isDM ? "direct message" : payload.hints?.isMention ? "you were @-mentioned" : isInvestor ? "investor — Ed or Malcolm" : "key person involved"}. Waiting for your sign-off before sending.`,
      tags,
      draft: {
        channel: payload.source === "email" ? "email" : "slack",
        to: recipient,
        subject: payload.source === "email" ? `Re: ${payload.title}` : undefined,
        // Empty string — AI draft is generated asynchronously after event creation
        body: "",
      },
    };
  }

  // 3) AUTO — everything else: decisions/actions extracted, relationship updated, memory written
  // Catch-all → lower confidence
  // Investor messages (Ed / Malcolm) are never sunk to "low" even if not replyable
  const autoPriority: EventPriority = isInvestor
    ? "high"
    : tags.includes("decision") || tags.includes("action")
      ? "normal"
      : "low";
  return {
    disposition: "auto",
    priority: autoPriority,
    confidence: 0.7,
    rationale: isInvestor
      ? "Investor message — filing automatically at high priority."
      : tags.includes("decision")
        ? "Decision signal detected — analysing and filing automatically."
        : tags.includes("action")
          ? "Action signal detected — analysing and filing automatically."
          : "Monitoring for context — no immediate action needed.",
    tags,
  };
}

export function eventFromIngest(p: IngestPayload): Omit<BasilEvent, "id" | "createdAt" | "updatedAt"> {
  const c = classify(p);
  const headline = buildHeadline(p, c.disposition);

  // Store the full ingest payload for debugging / future reprocessing
  const payload: Record<string, unknown> = {
    title: p.title,
    body: p.body,
    from: p.from,
    channel: p.channel,
    hints: p.hints,
  };

  return {
    source: p.source,
    // Populate both canonical and legacy fields so old + new code both work
    sourceRef: p.externalId,
    externalId: p.externalId,
    payload,
    headline,
    context: `${p.title}\n\n${p.body}`.trim(),
    draft: c.draft,
    entityName: p.from,
    disposition: c.disposition,
    priority: c.priority,
    status: c.disposition === "auto" ? "executed" : "pending",
    rationale: c.rationale,
    tags: c.tags,
    confidence: c.confidence,
  };
}

function buildHeadline(p: IngestPayload, d: EventDisposition): string {
  const who = p.from || p.channel || "unknown";
  const verb =
    d === "auto" ? "Logged" : d === "draft" ? "Drafted reply" : "Flagged";
  const what =
    p.source === "email"
      ? `email from ${who}`
      : p.source === "slack"
        ? `Slack in ${p.channel || who}`
        : p.source === "calendar"
          ? `calendar: ${p.title}`
          : p.source === "zoom_email"
            ? `meeting recap: ${p.title}`
            : p.source;
  return `${verb} — ${what}`;
}
