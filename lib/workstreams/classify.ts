/**
 * lib/workstreams/classify.ts — give everything a workstream.
 *
 * For each subject, in order: the user's own verdict → a routing rule (theirs,
 * then built-in) → a stored verdict → the fast-tier classifier, in batches,
 * capped per pass. The user's last few corrections go to the classifier as
 * examples, so it learns how this user files things.
 *
 * Never throws: a failed classifier leaves things unsorted, never blocks Today.
 */
import "server-only";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { routeByRules, type RouteSubject } from "@/lib/workstreams/rules";
import { readWorkstreams, saveVerdicts, type Verdict, type WorkstreamStore } from "@/lib/workstreams/store";
import { WORKSTREAMS, isWorkstream, type Workstream, type WorkstreamBy } from "@/lib/workstreams/types";

export interface Assigned {
  workstream: Workstream | null;
  by: WorkstreamBy;
}

const BATCH = 25;
/** Classifier items per pass — the rest wait for the next refresh. */
const DEFAULT_AI_LIMIT = 50;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Exported for tests. */
export function workstreamPrompt(subjects: readonly RouteSubject[], examples: ReadonlyArray<{ t: string; w: Workstream }>): string {
  const defs = WORKSTREAMS.map((w) => `- ${w.id} (${w.label}): ${w.blurb}`).join("\n");
  const ex = examples.length
    ? `\nHow the user has filed things before (follow these):\n${examples.map((e) => `- "${clip(e.t, 120)}" → ${e.w}`).join("\n")}\n`
    : "";
  const lines = subjects.map((s) => {
    const meta = [s.source && `from ${s.source}`, s.senderEmail && `sender ${s.senderEmail}`, s.channel && `#${s.channel}`, s.project && `project ${s.project}`]
      .filter(Boolean).join(", ");
    return `[${s.key}] ${clip(s.text.replace(/\s+/g, " "), 300)}${meta ? ` (${meta})` : ""}`;
  }).join("\n");
  return `File each item below into ONE of the user's workstreams.

${defs}
- none: fits none of them (personal life, newsletters, social).
${ex}
Judge by what the work IS, not by who sent it: a colleague asking about an invoice is operations; a client reporting a bug is product if the task is fixing it, clients if the task is replying to the client. If torn between two, pick the one the next step belongs to.

Items:
${lines}

Return ONLY a JSON array, no prose: [{"id":"<id>","w":"operations|product|research|clients|none"}]`;
}

/** Lenient: the first JSON array in the text. Exported for tests. */
export function parseVerdicts(text: string): Map<string, Workstream | null> {
  const out = new Map<string, Workstream | null>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return out;
  try {
    const arr = JSON.parse(text.slice(start, end + 1)) as Array<{ id?: unknown; w?: unknown }>;
    for (const r of Array.isArray(arr) ? arr : []) {
      if (typeof r?.id !== "string") continue;
      if (isWorkstream(r.w)) out.set(r.id, r.w);
      else if (r.w === "none") out.set(r.id, null);
    }
  } catch { /* unparseable: nothing learned */ }
  return out;
}

export async function assignWorkstreams(
  username: string,
  subjects: readonly RouteSubject[],
  opts: { aiLimit?: number; store?: WorkstreamStore } = {},
): Promise<Map<string, Assigned>> {
  const out = new Map<string, Assigned>();
  if (subjects.length === 0) return out;
  const store = opts.store ?? await readWorkstreams(username).catch(() => ({ rules: [], verdicts: {} } as WorkstreamStore));
  const now = new Date().toISOString();
  const learned: Record<string, Verdict> = {};
  const pending: RouteSubject[] = [];

  for (const s of subjects) {
    const v = store.verdicts[s.key];
    if (v?.by === "user") { out.set(s.key, { workstream: v.w, by: "user" }); continue; }
    const hit = routeByRules(s, store.rules);
    if (hit) {
      out.set(s.key, { workstream: hit.workstream, by: "rule" });
      continue;
    }
    if (v) { out.set(s.key, { workstream: v.w, by: v.by }); continue; }
    pending.push(s);
  }

  const todo = pending.slice(0, opts.aiLimit ?? DEFAULT_AI_LIMIT);
  if (todo.length > 0) {
    const examples = Object.values(store.verdicts)
      .filter((v): v is Verdict & { w: Workstream; t: string } => v.by === "user" && !!v.w && !!v.t)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 12)
      .map((v) => ({ t: v.t, w: v.w }));
    const system = await getTaskSystemPrompt(username, undefined, { memories: 0 }).catch(() => "You file work items for an executive.");
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      try {
        const r = await generateTextSafe({
          system,
          prompt: workstreamPrompt(batch, examples),
          // ≥1,000: the OpenAI fallback is a reasoning model and spends tokens thinking.
          maxOutputTokens: 1_000 + batch.length * 40,
        }, "fast", { username, feature: "workstreams" });
        const verdicts = parseVerdicts(r.text);
        for (const s of batch) {
          if (!verdicts.has(s.key)) continue;
          const w = verdicts.get(s.key) ?? null;
          out.set(s.key, { workstream: w, by: "ai" });
          learned[s.key] = { w, by: "ai", at: now };
        }
      } catch (e) {
        console.warn("[workstreams] classifier failed:", e instanceof Error ? e.message : e);
        break; // spend cap or outage: stop this pass, keep what was learned
      }
    }
  }

  if (Object.keys(learned).length) await saveVerdicts(username, learned).catch((e) => console.warn("[workstreams] save failed:", e instanceof Error ? e.message : e));
  return out;
}

/**
 * At read time: re-apply the user's choices and rules to a cached feed (no
 * classifier), so a correction shows on the next load, not the next refresh.
 */
export async function overlayWorkstreams<T extends { workstream?: Workstream | null; workstreamBy?: WorkstreamBy }>(
  username: string,
  items: readonly T[],
  subjectOf: (item: T) => RouteSubject,
): Promise<T[]> {
  if (items.length === 0) return [...items];
  const subjects = items.map(subjectOf);
  const placed = await assignWorkstreams(username, subjects, { aiLimit: 0 }).catch(() => new Map<string, Assigned>());
  return items.map((it, i) => {
    const p = placed.get(subjects[i].key);
    return p ? { ...it, workstream: p.workstream, workstreamBy: p.by } : it;
  });
}
