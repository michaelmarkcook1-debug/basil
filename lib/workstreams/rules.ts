/**
 * lib/workstreams/rules.ts — routing without a model.
 *
 * Order: the user's own rules (an exact sender beats a domain beats a channel
 * beats a project beats a keyword), then a few built-in rules chosen for
 * precision over recall. Anything they cannot place confidently is left for
 * the classifier — a wrong label is worse than "not sorted yet".
 *
 * Pure.
 */

import type { Workstream, WorkstreamRule } from "@/lib/workstreams/types";

/** One thing to place: an action, an awaiting-reply thread, a Linear issue. */
export interface RouteSubject {
  /** Stable key: the action id, or the feed item id. */
  key: string;
  text: string;
  source?: string;
  senderEmail?: string;
  /** Slack channel name, when the item came from a channel. */
  channel?: string;
  /** Project / Linear project name. */
  project?: string;
}

export interface RouteHit {
  workstream: Workstream;
  /** The user's rule id, or "builtin:<name>". */
  rule: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasWord = (hay: string, needle: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}($|[^\\p{L}\\p{N}])`, "iu").test(hay);

export function domainOf(email?: string): string | undefined {
  const at = email?.lastIndexOf("@") ?? -1;
  return email && at > 0 ? email.slice(at + 1).trim().toLowerCase() : undefined;
}

const FIELD_ORDER: Record<WorkstreamRule["field"], number> = { sender: 0, domain: 1, channel: 2, project: 3, keyword: 4 };

function userRuleHit(s: RouteSubject, rules: readonly WorkstreamRule[]): RouteHit | null {
  const sender = s.senderEmail?.trim().toLowerCase();
  const domain = domainOf(sender);
  const channel = s.channel?.replace(/^#/, "").trim().toLowerCase();
  const project = s.project?.trim().toLowerCase();
  const sorted = [...rules].sort((a, b) => FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || b.createdAt.localeCompare(a.createdAt));
  for (const r of sorted) {
    const v = r.value.trim().toLowerCase();
    if (!v) continue;
    const hit =
      (r.field === "sender" && sender === v) ||
      (r.field === "domain" && !!domain && (domain === v || domain.endsWith(`.${v}`))) ||
      (r.field === "channel" && channel === v.replace(/^#/, "")) ||
      (r.field === "project" && project === v) ||
      (r.field === "keyword" && hasWord(s.text, v));
    if (hit) return { workstream: r.workstream, rule: r.id };
  }
  return null;
}

// Built-in channel names: a channel called #eng-* or #sales is about as clear
// as a signal gets.
const CHANNEL_RULES: ReadonlyArray<[Workstream, RegExp]> = [
  ["product", /(^|[-_])(eng|engineering|dev|devs|product|platform|bugs?|release|releases|deploy|tech|design|data|ai)([-_]|$)/],
  ["clients", /(^|[-_])(sales|clients?|customers?|deals|pipeline|bizdev|gtm|accounts|partners?|cs)([-_]|$)/],
  ["operations", /(^|[-_])(ops|operations|finance|admin|hr|legal|people|hiring|recruiting|accounts-payable)([-_]|$)/],
  ["research", /(^|[-_])(research|insights|analysts?|market|intel)([-_]|$)/],
];

// Built-in phrases: only words that, in a task line, almost always mean one
// workstream. Ambiguous ones ("deal", "feature", "onboarding", "quote") are
// deliberately absent — the classifier reads those in context.
const KEYWORD_RULES: ReadonlyArray<[Workstream, RegExp]> = [
  ["product", /\b(bugs?|deploy(ment)?s?|pull requests?|merge|staging|hotfix|release notes|sprint|spec|api|backend|frontend|figma|github|vercel|linear issue|regression)\b/i],
  ["operations", /\b(invoices?|payroll|expenses?|receipts?|vat|tax return|accountant|bookkeep\w*|insurance|hmrc|companies house|pension|offer letter|employment contract|nda|supplier|bank transfer|board pack)\b/i],
  ["research", /\b(literature review|research paper|white ?paper|market sizing|competitor analysis|competitive analysis|survey results|analyst report|desk research)\b/i],
  ["clients", /\b(proposal|pitch deck|demo|prospects?|pipeline|rfp|tender|statement of work|sow|renewal|client|customer|account plan|pricing proposal)\b/i],
];

/** True when an address belongs to one of the user's clients (from their CRM). */
export type ClientMatcher = (email?: string) => boolean;

function builtinHit(s: RouteSubject, isClient?: ClientMatcher): RouteHit | null {
  if (s.source === "linear") return { workstream: "product", rule: "builtin:linear" };
  // Your CRM is the clearest signal there is: a Pipedrive activity, or mail
  // from a Pipedrive person or one of their organisations' domains.
  if (s.source === "pipedrive") return { workstream: "clients", rule: "builtin:pipedrive" };
  if (isClient?.(s.senderEmail)) return { workstream: "clients", rule: "builtin:pipedrive-contact" };
  const channel = s.channel?.replace(/^#/, "").trim().toLowerCase();
  if (channel) {
    const hits = CHANNEL_RULES.filter(([, re]) => re.test(channel));
    if (hits.length === 1) return { workstream: hits[0][0], rule: `builtin:channel` };
  }
  const found = new Set(KEYWORD_RULES.filter(([, re]) => re.test(s.text)).map(([w]) => w));
  // Two workstreams' words in one line ("send the client the bug fix") is a
  // judgement call: leave it to the classifier.
  if (found.size === 1) return { workstream: [...found][0], rule: "builtin:keyword" };
  return null;
}

export function routeByRules(s: RouteSubject, rules: readonly WorkstreamRule[], isClient?: ClientMatcher): RouteHit | null {
  return userRuleHit(s, rules) ?? builtinHit(s, isClient);
}
