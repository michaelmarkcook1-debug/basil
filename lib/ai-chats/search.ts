/**
 * Find past AI conversations about something. Pure — the store loads the
 * entries and excerpts, this ranks them. Tested in tests/ai-chats.test.mjs.
 */

export interface ChatEntry {
  key: string;
  platform: "claude-chat" | "chatgpt";
  id: string;
  updatedAt: string;
  work: boolean;
  /** Work conversations only — personal ones keep nothing but id and date. */
  title?: string;
  url?: string;
  createdAt?: string;
  summary?: string;
  topics?: string[];
  people?: string[];
  companies?: string[];
  decisions?: string[];
  openItems?: string[];
}

export interface ChatHit {
  platform: ChatEntry["platform"];
  title: string;
  url: string;
  updatedAt: string;
  summary: string;
  decisions: string[];
  openItems: string[];
  /** Up to ~300 characters of what was said around the match, when the match was in the words. */
  snippet?: string;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "about", "with", "what", "did", "we", "i", "my", "me", "is", "was", "do", "does"]);

export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9@.'-]+/i).map((w) => w.replace(/^['.-]+|['.-]+$/g, "")).filter((w) => w.length > 1 && !STOP.has(w)))];
}

function snip(text: string, word: string): string {
  const at = Math.max(0, text.toLowerCase().indexOf(word) - 120);
  return `${at ? "…" : ""}${text.slice(at, at + 300).replace(/\s+/g, " ").trim()}${at + 300 < text.length ? "…" : ""}`;
}

/**
 * Work conversations matching the query, best first. A word found in the
 * title, people, companies or topics counts more than one found only in the
 * words; every query word must appear somewhere. Ties go to the newest.
 */
export function searchChats(entries: ChatEntry[], excerpts: Record<string, string>, query: string, limit = 8): ChatHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const scored: Array<{ e: ChatEntry; score: number; snippet?: string }> = [];
  for (const e of entries) {
    if (!e.work) continue;
    const strong = [e.title, ...(e.people ?? []), ...(e.companies ?? []), ...(e.topics ?? [])].join(" \n ").toLowerCase();
    const digest = [e.summary, ...(e.decisions ?? []), ...(e.openItems ?? [])].join(" \n ").toLowerCase();
    const said = (excerpts[e.key] ?? "").toLowerCase();
    let score = 0;
    let snippetWord: string | undefined;
    let all = true;
    for (const w of words) {
      if (strong.includes(w)) score += 3;
      else if (digest.includes(w)) score += 2;
      else if (said.includes(w)) { score += 1; snippetWord ??= w; }
      else { all = false; break; }
    }
    if (!all) continue;
    scored.push({ e, score, snippet: snippetWord ? snip(excerpts[e.key] ?? "", snippetWord) : undefined });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.e.updatedAt < b.e.updatedAt ? 1 : -1))
    .slice(0, limit)
    .map(({ e, snippet }) => ({
      platform: e.platform,
      title: e.title ?? "Untitled conversation",
      url: e.url ?? "",
      updatedAt: e.updatedAt,
      summary: e.summary ?? "",
      decisions: e.decisions ?? [],
      openItems: e.openItems ?? [],
      ...(snippet ? { snippet } : {}),
    }));
}

/** Work conversations that mention any of these names (people or companies), newest first. */
export function chatsAbout(entries: ChatEntry[], names: string[], sinceIso: string, limit = 5): ChatEntry[] {
  const wanted = names.map((n) => n.trim().toLowerCase()).filter((n) => n.length > 2);
  if (wanted.length === 0) return [];
  return entries
    .filter((e) => e.work && e.updatedAt >= sinceIso)
    .filter((e) => {
      const hay = [e.title, e.summary, ...(e.people ?? []), ...(e.companies ?? [])].join(" ").toLowerCase();
      return wanted.some((n) => hay.includes(n));
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit);
}
