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
import { learnRules, ruleId, type Features, type Filing } from "@/lib/workstreams/learn";

export interface Verdict {
  /** null = the classifier looked and it fits none of the four. */
  w: Workstream | null;
  by: WorkstreamBy;
  at: string;
  /** The text it was given, kept short — user verdicts are the classifier's examples. */
  t?: string;
  /** User verdicts: what the item was (sender, channel, project, source), for learning patterns. */
  f?: Features;
  /** User verdicts: what Basil had before the user chose, for keeping score. */
  was?: Filing["was"];
}

export interface WorkstreamStore {
  rules: WorkstreamRule[];
  verdicts: Record<string, Verdict>;
  /** "field:value" of learned rules the user deleted — never learned again. */
  suppressed?: string[];
}

const FILE = "workstreams.json";
const EMPTY: WorkstreamStore = { rules: [], verdicts: {} };
/** Non-user verdicts older than this are dropped: their items are long gone. */
const KEEP_DAYS = 60;
const MAX_VERDICTS = 3_000;

export async function readWorkstreams(username: string, opts: { fresh?: boolean } = {}): Promise<WorkstreamStore> {
  const s = await readUserStore<WorkstreamStore>(username, FILE, EMPTY, opts);
  return {
    rules: Array.isArray(s?.rules) ? s.rules : [],
    verdicts: s?.verdicts && typeof s.verdicts === "object" ? s.verdicts : {},
    suppressed: Array.isArray(s?.suppressed) ? s.suppressed : [],
  };
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
    return { ...cur, rules: cur?.rules ?? [], verdicts: prune(verdicts) };
  }, EMPTY, { allowShrink: true });
}

/** Every user filing, as learning sees it. */
export function filingsOf(verdicts: Record<string, Verdict>): Filing[] {
  return Object.values(verdicts)
    .filter((v): v is Verdict & { w: Workstream } => v.by === "user" && !!v.w)
    .map((v) => ({ w: v.w, at: v.at, ...(v.t ? { t: v.t } : {}), ...(v.f ? { f: v.f } : {}), ...(v.was ? { was: v.was } : {}) }));
}

function cleanFeatures(f?: Features): Features | undefined {
  if (!f) return undefined;
  const out: Features = {};
  for (const k of ["sender", "channel", "project", "source"] as const) {
    const v = f[k]?.trim().toLowerCase().slice(0, 200);
    if (v) out[k] = k === "channel" ? v.replace(/^#/, "") : v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface FiledResult {
  store: WorkstreamStore;
  /** Rules Basil just learned from this filing. */
  learned: WorkstreamRule[];
  /** Learned rules this filing contradicted, now gone. */
  unlearned: WorkstreamRule[];
}

/** The user files something; optionally teach a rule so the next one routes itself. */
export async function setUserWorkstream(
  username: string,
  key: string,
  workstream: Workstream | null,
  opts: {
    text?: string;
    learn?: Pick<WorkstreamRule, "field" | "value">;
    features?: Features;
    was?: Filing["was"];
    ownDomains?: readonly string[];
  } = {},
): Promise<FiledResult> {
  if (workstream !== null && !isWorkstream(workstream)) throw new Error("unknown workstream");
  const now = new Date().toISOString();
  let learned: WorkstreamRule[] = [];
  let unlearned: WorkstreamRule[] = [];
  const store = await updateUserStore<WorkstreamStore>(username, FILE, (cur) => {
    const verdicts = { ...(cur?.verdicts ?? {}) };
    const f = cleanFeatures(opts.features);
    if (workstream === null) delete verdicts[key];
    else verdicts[key] = {
      w: workstream, by: "user", at: now,
      ...(opts.text ? { t: opts.text.slice(0, 160) } : {}),
      ...(f ? { f } : {}),
      ...(opts.was && opts.was.by !== ("user" as string) ? { was: opts.was } : {}),
    };
    let rules = [...(cur?.rules ?? [])];
    const learnValue = opts.learn?.value.trim().toLowerCase();
    if (workstream && opts.learn && learnValue) {
      // Taught by hand: replaces any rule (learned or not) for the same thing.
      rules = rules.filter((r) => !(r.field === opts.learn!.field && r.value === learnValue));
      rules.push({ id: `wsr-${randomUUID().slice(0, 8)}`, field: opts.learn.field, value: learnValue, workstream, createdAt: now });
    }
    const pruned = prune(verdicts);
    const result = learnRules(filingsOf(pruned), rules, { suppressed: cur?.suppressed, ownDomains: opts.ownDomains, now });
    learned = result.added;
    unlearned = result.removed;
    return { rules: result.rules, verdicts: pruned, suppressed: cur?.suppressed ?? [] };
  }, EMPTY, { allowShrink: true });
  return { store, learned, unlearned };
}

export async function deleteRule(username: string, id: string): Promise<boolean> {
  let found = false;
  await updateUserStore<WorkstreamStore>(username, FILE, (cur) => {
    const suppressed = [...(cur?.suppressed ?? [])];
    const rules = (cur?.rules ?? []).filter((r) => {
      const keep = r.id !== id;
      if (!keep) {
        found = true;
        // A learned rule the user removed must not come straight back.
        if (r.learned && !suppressed.includes(ruleId(r.field, r.value))) suppressed.push(ruleId(r.field, r.value));
      }
      return keep;
    });
    return { rules, verdicts: cur?.verdicts ?? {}, suppressed: suppressed.slice(-500) };
  }, EMPTY, { allowShrink: true });
  return found;
}
