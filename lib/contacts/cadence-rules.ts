/**
 * lib/contacts/cadence-rules.ts — "keep in touch with Jane every three weeks".
 *
 * A relationship cadence is a memory, exactly as follow-up rules are
 * (lib/actions/follow-up-rules.ts). The user says it once — in chat, or on
 * the memory page — and the delta engine turns silence past that cadence into
 * a high-severity signal for that person, regardless of how "key" recency
 * would otherwise rate them. Names resolve against the user's own contacts.
 */

export interface CadenceRule {
  contactId: string;
  name: string;
  everyDays: number;
  memoryId: string;
}

const UNIT_DAYS: Record<string, number> = { day: 1, week: 7, fortnight: 14, month: 30, quarter: 90 };
const ADVERB_DAYS: Record<string, number> = { daily: 1, weekly: 7, fortnightly: 14, monthly: 30, quarterly: 90 };

const NAME = "([A-Z][\\w'’.-]+(?:\\s+[A-Z][\\w'’.-]+){0,2})";
const VERB = "(?:keep in touch|stay in touch|stay in contact|check in|check-in|touch base|catch up|speak|talk|meet|call)";
const LINK = "(?:with|to)";

const PATTERNS: RegExp[] = [
  // keep in touch with Jane Doe every 3 weeks / each month / every fortnight
  new RegExp(`${VERB}\\s+${LINK}\\s+${NAME}\\s+(?:every|each)\\s+(?:(\\d+)\\s+)?(day|week|fortnight|month|quarter)s?\\b`, "i"),
  // check in with Jane monthly
  new RegExp(`${VERB}\\s+${LINK}\\s+${NAME}\\s+(daily|weekly|fortnightly|monthly|quarterly)\\b`, "i"),
  // Jane Doe — monthly check-in / weekly catch-up
  new RegExp(`^${NAME}\\s*[—–:-]\\s*(daily|weekly|fortnightly|monthly|quarterly)\\s+(?:check[- ]?in|catch[- ]?up|call|touch ?point|contact)`, "i"),
  // monthly check-in with Jane
  new RegExp(`(daily|weekly|fortnightly|monthly|quarterly)\\s+(?:check[- ]?in|catch[- ]?up|call|touch ?point|contact)\\s+with\\s+${NAME}`, "i"),
];

export function parseCadence(content: string): { name: string; everyDays: number } | null {
  const text = content.trim();
  for (const [i, re] of PATTERNS.entries()) {
    const m = re.exec(text);
    if (!m) continue;
    if (i === 0) {
      const n = m[2] ? parseInt(m[2], 10) : 1;
      const unit = UNIT_DAYS[m[3].toLowerCase()];
      if (!unit || !Number.isFinite(n) || n <= 0) continue;
      return { name: m[1].trim(), everyDays: n * unit };
    }
    if (i === 3) return { name: m[2].trim(), everyDays: ADVERB_DAYS[m[1].toLowerCase()] };
    return { name: m[1].trim(), everyDays: ADVERB_DAYS[m[2].toLowerCase()] };
  }
  return null;
}

/** Resolve a name to one contact: full name first, then a unique first name. */
export function resolveContact<C extends { id: string; name: string }>(name: string, contacts: ReadonlyArray<C>): C | null {
  const want = name.toLowerCase();
  const full = contacts.find((c) => c.name.toLowerCase() === want);
  if (full) return full;
  const first = want.split(/\s+/)[0];
  const byFirst = contacts.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === first);
  return byFirst.length === 1 ? byFirst[0] : null;
}

export function extractCadenceRules<C extends { id: string; name: string }>(
  memories: ReadonlyArray<{ id: string; content: string }>,
  contacts: ReadonlyArray<C>,
): CadenceRule[] {
  const out = new Map<string, CadenceRule>();
  for (const m of memories) {
    const parsed = parseCadence(m.content);
    if (!parsed) continue;
    const c = resolveContact(parsed.name, contacts);
    if (!c) continue;
    // The tightest cadence for a person wins.
    const prev = out.get(c.id);
    if (!prev || parsed.everyDays < prev.everyDays) out.set(c.id, { contactId: c.id, name: c.name, everyDays: parsed.everyDays, memoryId: m.id });
  }
  return [...out.values()];
}
