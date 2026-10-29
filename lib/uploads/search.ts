/**
 * lib/uploads/search.ts — find lines in uploaded transcripts and documents.
 * Pure: the chat tool loads the texts, this ranks and snips. Exported for tests.
 */
import { clockLabel, offsetLabel, type Segment, type UploadRecord } from "./shape";

export interface UploadHit { title: string; occurredAt: string; when?: string; at?: string; text: string; uploadId: string }

/** Document text → paragraphs; very long ones in ~800-character windows. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const p of text.split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    if (p.length <= 1500) { out.push(p); continue; }
    for (let i = 0; i < p.length; i += 700) out.push(p.slice(i, i + 800));
  }
  return out;
}

/** ~400 characters around the first match. */
function snip(text: string, word: string): string {
  if (text.length <= 400) return text;
  const at = Math.max(0, text.toLowerCase().indexOf(word) - 150);
  return `${at ? "…" : ""}${text.slice(at, at + 400).trim()}${at + 400 < text.length ? "…" : ""}`;
}

/** Every query word must appear (case-insensitive); best-covered lines first, newest uploads first on ties. */
export function searchUploadText(
  texts: Array<{ u: Pick<UploadRecord, "id" | "title" | "occurredAt">; t: { segments?: Segment[]; text?: string } }>,
  query: string,
  limit = 15,
): UploadHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits: Array<UploadHit & { score: number }> = [];
  for (const { u, t } of texts) {
    const lines: Array<{ text: string; start?: number }> = t.segments?.length
      ? t.segments.map((s) => ({ text: s.text, start: s.start }))
      : paragraphs(t.text ?? "").map((x) => ({ text: x }));
    for (const line of lines) {
      const low = line.text.toLowerCase();
      const found = words.filter((w) => low.includes(w)).length;
      if (found < words.length) continue;
      hits.push({
        uploadId: u.id, title: u.title, occurredAt: u.occurredAt,
        ...(line.start !== undefined ? { when: clockLabel(u.occurredAt, line.start), at: offsetLabel(line.start) } : {}),
        text: snip(line.text, words[0]),
        score: found,
      });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit)
    .map(({ score: _score, ...h }) => h);
}
