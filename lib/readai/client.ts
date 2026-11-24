/**
 * lib/readai/client.ts — Read AI meetings, read-only (REST API, open beta).
 *
 *   GET https://api.read.ai/v1/meetings?limit&cursor&start_time_ms.gte  → list
 *   GET https://api.read.ai/v1/meetings/{id}?expand[]=…                  → one meeting
 * expand: summary, chapter_summaries, action_items, key_questions, topics,
 * transcript (speakers + turns with ms timestamps), metrics.
 * Up to 100 requests a minute per user. Shapes are read defensively.
 */
import "server-only";
import { readAiAccessToken, ReadAiAuthError } from "@/lib/readai/oauth";

const BASE = "https://api.read.ai/v1";
const TIMEOUT_MS = 30_000;
const EXPAND = ["summary", "chapter_summaries", "action_items", "key_questions", "topics", "transcript", "metrics"];

export interface ReadAiParticipant { name?: string; email?: string; attended?: boolean }
export interface ReadAiMeetingRef { id: string; title: string; startMs: number; endMs?: number; participants: ReadAiParticipant[]; reportUrl?: string; platform?: string }
export interface ReadAiTurn { speaker?: string; text: string; startMs: number; endMs?: number }
export interface ReadAiMeeting extends ReadAiMeetingRef {
  summary?: string;
  chapters: string[];
  actionItems: string[];
  keyQuestions: string[];
  topics: string[];
  turns: ReadAiTurn[];
  metrics?: { readScore?: number; sentiment?: number; engagement?: number };
}

async function get<T>(username: string, path: string): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await readAiAccessToken(username, { force: attempt > 0 });
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) throw new ReadAiAuthError("Read AI rejected Basil's sign-in.");
    if (res.status === 429) throw new Error("Read AI rate limit reached; the rest follow on the next sync.");
    if (!res.ok) throw new Error(`Read AI ${res.status}`);
    return (await res.json()) as T;
  }
  throw new ReadAiAuthError("Read AI needs reconnecting.");
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

/** Strings from an array of strings or of objects carrying text/title/question/summary. */
export function texts(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === "string" && v.trim() ? [v] : [];
  return v.map((x) => typeof x === "string" ? x : str((x as Record<string, unknown>)?.text) ?? str((x as Record<string, unknown>)?.title) ?? str((x as Record<string, unknown>)?.question) ?? str((x as Record<string, unknown>)?.summary) ?? str((x as Record<string, unknown>)?.description) ?? "")
    .map((s) => s.trim()).filter(Boolean);
}

export function toRef(o: Record<string, unknown>): ReadAiMeetingRef | null {
  const id = str(o?.id);
  if (!id) return null;
  const participants = Array.isArray(o.participants)
    ? (o.participants as Array<Record<string, unknown>>).map((p) => ({ name: str(p?.name), email: str(p?.email)?.toLowerCase(), attended: typeof p?.attended === "boolean" ? p.attended as boolean : undefined }))
    : [];
  return {
    id, title: str(o.title) ?? "Read AI meeting", startMs: num(o.start_time_ms) ?? Date.now(), endMs: num(o.end_time_ms),
    participants, reportUrl: str(o.report_url), platform: str(o.platform),
  };
}

export function toMeeting(o: Record<string, unknown>): ReadAiMeeting | null {
  const ref = toRef(o);
  if (!ref) return null;
  const t = (o.transcript ?? {}) as Record<string, unknown>;
  const turns: ReadAiTurn[] = Array.isArray(t.turns)
    ? (t.turns as Array<Record<string, unknown>>).map((x) => ({
        speaker: str((x.speaker as Record<string, unknown>)?.name) ?? str(x.speaker),
        text: (str(x.text) ?? "").trim(),
        startMs: num(x.start_time_ms) ?? ref.startMs,
        endMs: num(x.end_time_ms),
      })).filter((x) => x.text)
    : [];
  const m = (o.metrics ?? {}) as Record<string, unknown>;
  return {
    ...ref,
    summary: str(o.summary) ?? texts(o.summary).join("\n") ?? undefined,
    chapters: texts(o.chapter_summaries),
    actionItems: texts(o.action_items),
    keyQuestions: texts(o.key_questions),
    topics: texts(o.topics),
    turns,
    metrics: { readScore: num(m.read_score), sentiment: num(m.sentiment), engagement: num(m.engagement) },
  };
}

/** Meetings that started at or after `sinceMs`, newest first, up to `max`. */
export async function listReadAiMeetings(username: string, sinceMs: number, max = 200): Promise<ReadAiMeetingRef[]> {
  const out: ReadAiMeetingRef[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < max; page++) {
    const q = new URLSearchParams({ limit: "10", "start_time_ms.gte": String(sinceMs), ...(cursor ? { cursor } : {}) });
    const body = await get<Record<string, unknown>>(username, `/meetings?${q}`);
    const data = (Array.isArray(body.data) ? body.data : Array.isArray(body.meetings) ? body.meetings : Array.isArray(body) ? body : []) as Array<Record<string, unknown>>;
    for (const d of data) { const r = toRef(d); if (r) out.push(r); }
    const next = str(body.next_cursor) ?? str((body.pagination as Record<string, unknown>)?.next_cursor) ?? (body.has_more && data.length ? str(data[data.length - 1]?.id) : undefined);
    if (!next || data.length === 0) break;
    cursor = next;
  }
  return out.sort((a, b) => b.startMs - a.startMs).slice(0, max);
}

export async function getReadAiMeeting(username: string, id: string): Promise<ReadAiMeeting | null> {
  const q = EXPAND.map((e) => `expand[]=${e}`).join("&");
  const body = await get<Record<string, unknown>>(username, `/meetings/${encodeURIComponent(id)}?${q}`);
  return toMeeting((body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>);
}
