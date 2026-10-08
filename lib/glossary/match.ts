/**
 * lib/glossary/match.ts — pure glossary logic (no server imports; used by the
 * prompt builders, the API and tests).
 *
 * The user's shorthand — AG, AIE, AP/TG, IIAR — appeared hundreds of times in
 * actions, email and chat, and every model call had to guess what it meant.
 * The glossary is the decoder: confirmed meanings go into prompts; unknown
 * shorthand is surfaced so the user can say what it means once.
 */

export type GlossaryKind = "acronym" | "project" | "person" | "term";

export interface GlossaryEntry {
  id: string;
  term: string;
  meaning: string;
  kind: GlossaryKind;
  /** Other spellings that mean the same thing ("the migration", "T"). */
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does `text` use this term? Word boundaries always; case-sensitive for
 * all-caps shorthand (so "AG" doesn't fire on "ag" in "agree"), otherwise not.
 */
export function mentions(text: string, term: string): boolean {
  const t = term.trim();
  if (t.length < 2) return false;
  const allCaps = t === t.toUpperCase() && /[A-Z]/.test(t);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, allCaps ? "u" : "iu").test(text);
}

/** Entries the text actually uses (by term or alias), in a stable order. */
export function termsIn(text: string, entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  if (!text.trim()) return [];
  return sortEntries(entries.filter((e) => [e.term, ...e.aliases].some((t) => mentions(text, t))));
}

export function sortEntries(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return [...entries].sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

const KIND_LABEL: Record<GlossaryKind, string> = { acronym: "", project: "project", person: "person", term: "" };

/** One line per entry: "- **AG** — AnalystGenius (project; also: Analyst Genius)". */
export function glossaryLines(entries: readonly GlossaryEntry[]): string {
  return sortEntries(entries).map((e) => {
    const extra = [KIND_LABEL[e.kind], e.aliases.length ? `also: ${e.aliases.join(", ")}` : ""].filter(Boolean).join("; ");
    return `- **${e.term}** — ${e.meaning}${extra ? ` (${extra})` : ""}`;
  }).join("\n");
}

/**
 * Shorthand anyone would know. Never asked about: asking a CEO what "CEO"
 * means is how a glossary feature gets switched off.
 */
export const COMMON_SHORTHAND = new Set([
  "AI", "API", "APIS", "UI", "UX", "LLM", "LLMS", "ML", "CEO", "CFO", "COO", "CTO", "CMO", "CRO", "CPO", "VP", "SVP", "EVP",
  "IT", "PM", "AM", "DM", "DMS", "HR", "PR", "QA", "OK", "FYI", "ASAP", "EOD", "EOW", "ETA", "TBD", "TBC", "KPI", "KPIS",
  "ROI", "SAAS", "B2B", "B2C", "CRM", "SEO", "PDF", "URL", "ID", "IDS", "OOO", "FAQ", "MVP", "POC", "NDA", "SOW", "RFP", "RFI",
  "GTM", "BST", "GMT", "UTC", "CET", "CEST", "EST", "EDT", "PST", "PDT", "ET", "PT", "CT", "UK", "US", "USA", "EU", "UAE",
  "JSON", "SQL", "AWS", "GCP", "CSV", "HTML", "CSS", "LLC", "LTD", "INC", "PLC", "Q1", "Q2", "Q3", "Q4", "H1", "H2", "FY",
  "YOY", "MOM", "ARR", "MRR", "NPS", "SLA", "OKR", "OKRS", "CV", "PS", "NB", "RE", "FW", "FWD", "CC", "BCC", "TV", "PA", "EA",
  "AND", "THE", "FOR", "NOT", "NEW", "ALL", "NOW", "TODAY", "MY", "TO", "OF", "IN", "ON", "AT", "BY", "OR", "IS", "IT'S",
]);

// 2–7 capitals/digits starting with a letter, optionally joined by "/" ("AP/TG").
const SHORTHAND = /\b[A-Z][A-Z0-9&]{1,6}(?:\/[A-Z][A-Z0-9&]{0,6})?\b/g;

export interface UnknownShorthand { term: string; count: number; examples: string[] }

/**
 * Shorthand that appears repeatedly across the user's own material but has no
 * glossary entry yet. Pure — the caller decides which texts to scan.
 */
export function findUnknownShorthand(
  texts: readonly string[],
  known: readonly GlossaryEntry[],
  dismissed: readonly string[],
  opts: { minCount?: number; limit?: number } = {},
): UnknownShorthand[] {
  const skip = new Set([...COMMON_SHORTHAND, ...dismissed.map((d) => d.toUpperCase())]);
  for (const e of known) for (const t of [e.term, ...e.aliases]) skip.add(t.toUpperCase());
  const found = new Map<string, UnknownShorthand>();
  for (const text of texts) {
    for (const m of text.matchAll(SHORTHAND)) {
      const term = m[0];
      if (skip.has(term) || /^[A-Z]\d+$/.test(term)) continue;
      // A compound like AP/TG is skipped when every part is already known.
      if (term.includes("/") && term.split("/").every((p) => skip.has(p))) continue;
      const hit = found.get(term) ?? { term, count: 0, examples: [] };
      hit.count++;
      if (hit.examples.length < 3) {
        const at = m.index ?? 0;
        const snippet = text.slice(Math.max(0, at - 50), at + term.length + 60).replace(/\s+/g, " ").trim();
        if (!hit.examples.includes(snippet)) hit.examples.push(snippet);
      }
      found.set(term, hit);
    }
  }
  return [...found.values()]
    .filter((u) => u.count >= (opts.minCount ?? 2))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, opts.limit ?? 25);
}
