/**
 * lib/learning/priors.ts
 *
 * Category-level behaviour priors. The user's explicit engagement verb IS the
 * signal: items they keep marking Done = "instant" (engage now); items they keep
 * Pushing = "defer" (can wait); keep Delegating = "delegate"; keep Deleting =
 * "noise". We learn a disposition per task-class and use it to re-rank the feed
 * and pre-suggest the likely action.
 *
 * Task-class = the action's `category` when set, else its source type — so the
 * priors key the same way whether or not classification tagged a category.
 */

import type { LearningStore } from "./types";

export type Disposition = "instant" | "defer" | "delegate" | "noise" | "neutral";

export interface CategoryPrior {
  taskClass: string;
  total: number;
  done: number;
  push: number;
  delegate: number;
  delete: number;
  disposition: Disposition;
}

const MIN_SAMPLE = 3;       // need a few data points before trusting a pattern
const PRIOR_WINDOW_DAYS = 45;

function sourceTypeFromKey(sourceKey: string): string {
  return sourceKey.startsWith("slack:") ? "slack" : sourceKey;
}

/** Stable task-class key, computed identically from events and from actions. */
export function taskClassOf(category: string | undefined, sourceType: string): string {
  return category && category.trim() ? category : sourceType;
}

/** Task-class for a stored interaction event (which carries a sourceKey, not a source). */
export function eventTaskClass(category: string | undefined, sourceKey: string): string {
  return taskClassOf(category, sourceTypeFromKey(sourceKey));
}

function deriveDisposition(p: CategoryPrior): Disposition {
  if (p.total < MIN_SAMPLE) return "neutral";
  const rate = (n: number) => n / p.total;
  if (rate(p.push) >= 0.5) return "defer";
  if (rate(p.delegate) >= 0.5) return "delegate";
  if (rate(p.delete) >= 0.6) return "noise";
  if (rate(p.done) >= 0.5) return "instant";
  return "neutral";
}

export function computeCategoryPriors(store: LearningStore): Record<string, CategoryPrior> {
  const sinceMs = Date.now() - PRIOR_WINDOW_DAYS * 86_400_000;
  const map = new Map<string, CategoryPrior>();

  for (const e of store.events ?? []) {
    if (new Date(e.ts).getTime() < sinceMs) continue;
    const tc = taskClassOf(e.category, sourceTypeFromKey(e.sourceKey));
    const p = map.get(tc) ?? { taskClass: tc, total: 0, done: 0, push: 0, delegate: 0, delete: 0, disposition: "neutral" as Disposition };
    p.total += 1;
    if (e.action === "done") p.done += 1;
    else if (e.action === "push") p.push += 1;
    else if (e.action === "delegate") p.delegate += 1;
    else if (e.action === "delete") p.delete += 1;
    map.set(tc, p);
  }

  const out: Record<string, CategoryPrior> = {};
  for (const [tc, p] of map) {
    p.disposition = deriveDisposition(p);
    out[tc] = p;
  }
  return out;
}

export type SuggestVerb = "done" | "push" | "delegate";

export interface PriorEffect {
  rankMult: number;
  lane?: "later";
  hint?: string;
  suggest?: SuggestVerb;
}

/** How a disposition reshapes a feed item. */
export function priorEffect(d: Disposition): PriorEffect {
  switch (d) {
    case "instant":  return { rankMult: 1.35, hint: "You usually action these straight away" };
    case "defer":    return { rankMult: 0.5, lane: "later", hint: "You usually push these", suggest: "push" };
    case "delegate": return { rankMult: 0.95, hint: "You usually delegate these", suggest: "delegate" };
    case "noise":    return { rankMult: 0.4, lane: "later", hint: "You usually clear these" };
    default:         return { rankMult: 1 };
  }
}
