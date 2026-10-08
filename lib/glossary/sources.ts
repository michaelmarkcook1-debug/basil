import "server-only";
import { listActions } from "@/lib/actions/store";
import { listMemories } from "@/lib/memory/store";
import { listUserContacts } from "@/lib/contacts/user-store";
import { listDecisions } from "@/lib/decisions/store";

/**
 * The user's own written material — where their shorthand lives. Read from
 * Basil's stores only (no Gmail/Slack calls), so scanning is cheap and safe.
 */
export async function gatherOwnTexts(username: string): Promise<string[]> {
  const warn = (what: string) => (err: unknown) => {
    console.warn(`[glossary] could not read ${what}:`, err instanceof Error ? err.message : err);
    return [];
  };
  const [actions, memories, contacts, decisions] = await Promise.all([
    listActions(username).catch(warn("actions")),
    listMemories(username).catch(warn("memories")),
    listUserContacts(username).catch(warn("contacts")),
    listDecisions(username).catch(warn("decisions")),
  ]);
  return [
    ...actions.map((a) => a.text),
    ...memories.slice(0, 400).map((m) => m.content),
    ...contacts.flatMap((c) => [c.title, c.relationship, c.companyContext].filter((x): x is string => !!x)),
    ...decisions.flatMap((d) => [d.title, d.text].filter((x): x is string => !!x)),
  ];
}

/** Up to `max` snippets around a term, for the user (and the suggester) to read. */
export function contextsFor(term: string, texts: readonly string[], max = 4): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const i = t.indexOf(term);
    if (i === -1) continue;
    const snip = t.slice(Math.max(0, i - 80), i + term.length + 100).replace(/\s+/g, " ").trim();
    if (!out.includes(snip)) out.push(snip);
    if (out.length >= max) break;
  }
  return out;
}
