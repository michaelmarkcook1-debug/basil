/**
 * lib/workstreams/store.ts — the user's routing rules and Basil's verdicts.
 *
 * One small per-user file, `workstreams.json`:
 *   rules    — what the user taught ("everything from guy@ → Clients & Sales");
 *   verdicts — the workstream given to each feed item / action, and by whom,
 *              so the classifier never pays twice for the same thing and the
 *              user's own choice always wins.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { isWorkstream, type Workstream, type WorkstreamBy, type WorkstreamRule } from "@/lib/workstreams/types";

export interface Verdict {
  /** null = the classifier looked and it fits none of the four. */
  w: Workstream | null;
  by: WorkstreamBy;
  at: string;
  /** The text it was given, kept short — user verdicts are the classifier's examples. */
  t?: string;
}

export interface WorkstreamStore {
  rules: WorkstreamRule[];
  verdicts: Record<string, Verdict>;
}

const FILE = "workstreams.json";
const EMPTY: WorkstreamStore = { rules: [], verdicts: {} };
/** Non-user verdicts older than this are dropped: their items are long gone. */
const KEEP_DAYS = 60;
const MAX_VERDICTS = 3_000;

export async function readWorkstreams(username: string, opts: { fresh?: boolean } = {}): Promise<WorkstreamStore> {
  const s = await readUserStore<WorkstreamStore>(username, FILE, EMPTY, opts);
  return { rules: Array.isArray(s?.rules) ? s.rules : [], verdicts: s?.verdicts && typeof s.verdicts === "object" ? s.verdicts : {} };
}

function prune(verdicts: Record<string, Verdict>): Record<string, Verdict> {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
  const entries = Object.entries(verdicts).filter(([, v]) => v.by === "user" || v.at >= cutoff);
  if (entries.length <= MAX_VERDICTS) return Object.fromEntries(entries);
  entries.sort((a, b) => (a[1].by === "user" ? 1 : 0) - (b[1].by === "user" ? 1 : 0) || a[1].at.localeCompare(b[1].at));
  return Object.fromEntries(entries.slice(entries.length - MAX_VERDICTS));
}

/** Record machine verdicts. Never overwrites a choice the user made. */
export async function saveVerdicts(username: string, fresh: Record<string, Verdict>): Promise<void> {
  if (Object.keys(fresh).length === 0) return;
  await updateUserStore<WorkstreamStore>(username, FILE, (cur) => {
    const verdicts = { ...(cur?.verdicts ?? {}) };
    for (const [k, v] of Object.entries(fresh)) {
      if (verdicts[k]?.by === "user") continue;
      verdicts[k] = v;
    }
    return { rules: cur?.rules ?? [], verdicts: prune(verdicts) };
  }, EMPTY, { allowShrink: true });
}

/** The user files something; optionally teach a rule so the next one routes itself. */
export async function setUserWorkstream(
  username: string,
  key: string,
  workstream: Workstream | null,
  opts: { text?: string; learn?: Pick<WorkstreamRule, "field" | "value"> } = {},
): Promise<WorkstreamStore> {
  if (workstream !== null && !isWorkstream(workstream)) throw new Error("unknown workstream");
  const now = new Date().toISOString();
  return updateUserStore<WorkstreamStore>(username, FILE, (cur) => {
    const verdicts = { ...(cur?.verdicts ?? {}) };
    if (workstream === null) delete verdicts[key];
    else verdicts[key] = { w: workstream, by: "user", at: now, ...(opts.text ? { t: opts.text.slice(0, 160) } : {}) };
    let rules = [...(cur?.rules ?? [])];
    const learnValue = opts.learn?.value.trim().toLowerCase();
    if (workstream && opts.learn && learnValue) {
      rules = rules.filter((r) => !(r.field === opts.learn!.field && r.value === learnValue));
      rules.push({ id: `wsr-${randomUUID().slice(0, 8)}`, field: opts.learn.field, value: learnValue, workstream, createdAt: now });
    }
    return { rules, verdicts: prune(verdicts) };
  }, EMPTY, { allowShrink: true });
}

export async function deleteRule(username: string, id: string): Promise<boolean> {
  let found = false;
  await updateUserStore<WorkstreamStore>(username, FILE, (cur) => {
    const rules = (cur?.rules ?? []).filter((r) => { const keep = r.id !== id; if (!keep) found = true; return keep; });
    return { rules, verdicts: cur?.verdicts ?? {} };
  }, EMPTY, { allowShrink: true });
  return found;
}
