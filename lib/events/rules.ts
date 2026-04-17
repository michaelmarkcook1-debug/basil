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

const KEY_PEOPLE = ["malcolm", "ed baum", " ed ", "isaac", "olivia", "sam jordan"];

function isAboutKeyPerson(text: string): boolean {
  const t = text.toLowerCase();
  return KEY_PEOPLE.some((p) => t.includes(p));
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
}

export function classify(payload: IngestPayload): Classification {
  const combined = `${payload.title} ${payload.body}`;
  const tags = detectTags(combined);
  const aboutKeyPerson =
    payload.hints?.isFromKeyPerson || isAboutKeyPerson(combined);

  // 1) NOTIFY — money / legal / hiring / @here in exec
  const isHighStakes = ["money", "legal", "hiring"].some((t) => tags.includes(t));
  const isExecMention =
    payload.channel?.startsWith("#exec") && /@here|@channel/i.test(payload.body);

  if (isHighStakes || isExecMention) {
    return {
      disposition: "notify",
      priority: "high",
      rationale: isExecMention
        ? "@here in #exec — you'd want to see this live, not from a summary."
        : `Matches high-stakes rule (${tags.filter((t) => ["money", "legal", "hiring"].includes(t)).join(", ")}). Not acting automatically.`,
      tags,
    };
  }

  // 2) DRAFT — incoming email/Slack that wants a reply
  const isReplyable =
    (payload.source === "email" || payload.source === "slack") &&
    (payload.hints?.isDM ||
      payload.hints?.isGroupDM ||
      payload.hints?.isMention ||
      aboutKeyPerson);

  if (isReplyable) {
    const recipient = payload.from || payload.channel || "recipient";
    return {
      disposition: "draft",
      priority: aboutKeyPerson ? "high" : "normal",
      rationale: `Drafting a reply — ${payload.hints?.isDM ? "direct message" : payload.hints?.isMention ? "you were @-mentioned" : "key person involved"}. Waiting for your sign-off before sending.`,
      tags,
      draft: {
        channel: payload.source === "email" ? "email" : "slack",
        to: recipient,
        subject: payload.source === "email" ? `Re: ${payload.title}` : undefined,
        body: generateDraftBody(payload),
      },
    };
  }

  // 3) AUTO — everything else: decisions/actions extracted, relationship updated, memory written
  return {
    disposition: "auto",
    priority: tags.includes("decision") || tags.includes("action") ? "normal" : "low",
    rationale: tags.includes("decision")
      ? "Logged as a decision candidate. Ping me if you want to see it."
      : tags.includes("action")
        ? "Extracted as an action item and filed on the tracker."
        : "Updated relationship tracker and memory. No action needed from you.",
    tags,
  };
}

// Tiny placeholder drafter — the AI chat route would replace this with a real model call.
function generateDraftBody(p: IngestPayload): string {
  const opener = p.hints?.isDM ? "Hey" : "Hi";
  const who = p.from ? p.from.split(/[ <]/)[0] : "there";
  return `${opener} ${who},

Thanks for this. Let me take a look and come back with specifics — I want to make sure the response is right rather than rushed.

Michael`;
}

export function eventFromIngest(p: IngestPayload): Omit<BasilEvent, "id" | "createdAt" | "updatedAt"> {
  const c = classify(p);
  const headline = buildHeadline(p, c.disposition);

  return {
    source: p.source,
    externalId: p.externalId,
    headline,
    context: `${p.title}\n\n${p.body}`.trim(),
    draft: c.draft,
    entityName: p.from,
    disposition: c.disposition,
    priority: c.priority,
    status: c.disposition === "auto" ? "executed" : "pending",
    rationale: c.rationale,
    tags: c.tags,
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
          : p.source;
  return `${verb} — ${what}`;
}
