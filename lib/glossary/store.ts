import "server-only";
import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import type { GlossaryEntry, GlossaryKind } from "./match";

/** Per-user glossary: the decoder for the user's shorthand. */
const FILE = "sage-glossary.json";

export interface GlossaryFile {
  entries: GlossaryEntry[];
  /** Shorthand the user said is not worth defining — never suggested again. */
  dismissed: string[];
}
const EMPTY: GlossaryFile = { entries: [], dismissed: [] };
const KINDS: readonly GlossaryKind[] = ["acronym", "project", "person", "term"];
const clean = (s: string, max: number) => s.replace(/[\r\n]+/g, " ").trim().slice(0, max);

export async function getGlossary(username: string): Promise<GlossaryFile> {
  const g = await readUserStore<GlossaryFile>(username, FILE, EMPTY);
  return { entries: g.entries ?? [], dismissed: g.dismissed ?? [] };
}

/**
 * Add or update a term. Matching is case-insensitive on the term or any alias,
 * so "remember AG means AnalystGenius" twice updates one entry.
 */
export async function upsertTerm(
  username: string,
  input: { term: string; meaning: string; kind?: GlossaryKind; aliases?: string[] },
): Promise<GlossaryEntry> {
  const term = clean(input.term, 40);
  const meaning = clean(input.meaning, 200);
  if (!term || !meaning) throw new RangeError("A term and its meaning are both required.");
  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : (term === term.toUpperCase() ? "acronym" : "term");
  const aliases = [...new Set((input.aliases ?? []).map((a) => clean(a, 40)).filter((a) => a && a.toLowerCase() !== term.toLowerCase()))].slice(0, 8);
  const now = new Date().toISOString();
  let saved!: GlossaryEntry;
  await updateUserStore<GlossaryFile>(username, FILE, (cur) => {
    const entries = [...(cur.entries ?? [])];
    const key = term.toLowerCase();
    const i = entries.findIndex((e) => [e.term, ...e.aliases].some((t) => t.toLowerCase() === key));
    saved = i === -1
      ? { id: randomUUID(), term, meaning, kind, aliases, createdAt: now, updatedAt: now }
      : { ...entries[i], term, meaning, kind, aliases: aliases.length ? aliases : entries[i].aliases, updatedAt: now };
    if (i === -1) entries.push(saved); else entries[i] = saved;
    // Defining a term un-dismisses it.
    return { entries, dismissed: (cur.dismissed ?? []).filter((d) => d.toLowerCase() !== key) };
  }, EMPTY);
  return saved;
}

export async function removeTerm(username: string, id: string): Promise<boolean> {
  let removed = false;
  await updateUserStore<GlossaryFile>(username, FILE, (cur) => {
    const entries = (cur.entries ?? []).filter((e) => e.id !== id);
    removed = entries.length !== (cur.entries ?? []).length;
    return { entries, dismissed: cur.dismissed ?? [] };
  }, EMPTY, { allowShrink: true });
  return removed;
}

export async function dismissTerm(username: string, term: string): Promise<void> {
  const t = clean(term, 40);
  if (!t) return;
  await updateUserStore<GlossaryFile>(username, FILE, (cur) => ({
    entries: cur.entries ?? [],
    dismissed: [...new Set([...(cur.dismissed ?? []), t])].slice(-500),
  }), EMPTY);
}
