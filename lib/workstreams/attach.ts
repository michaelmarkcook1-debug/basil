/**
 * lib/workstreams/attach.ts — what each Today item / action is, as a subject
 * to route, and stamping the answer back on. Pure (no server-only imports), so
 * the shapes are testable.
 */

import type { ActionItem } from "@/lib/types/action";
import type { TodayFeedItem } from "@/lib/today/types";
import type { RouteSubject } from "@/lib/workstreams/rules";
import type { Workstream, WorkstreamBy } from "@/lib/workstreams/types";
import { WORKSTREAM_IDS } from "@/lib/workstreams/types";

export interface Placed { workstream: Workstream | null; by: WorkstreamBy }

export const actionKey = (id: string) => `action:${id}`;

export function actionSubject(a: Pick<ActionItem, "id" | "text" | "source" | "owner">): RouteSubject {
  return { key: actionKey(a.id), text: a.text, source: a.source };
}

/** The key a feed item's workstream is stored under — an action-backed card shares its action's. */
export function feedKey(item: TodayFeedItem): string {
  if (item.kind === "change" && item.change.source === "actions" && item.change.entityId) return actionKey(item.change.entityId);
  return item.id;
}

export function feedSubject(item: TodayFeedItem, actionsById?: ReadonlyMap<string, Pick<ActionItem, "id" | "text" | "source" | "owner">>): RouteSubject {
  const key = feedKey(item);
  if (item.kind === "followup") {
    const f = item.followup;
    return { key, text: `${f.subject} — ${f.preview}`, source: f.source, senderEmail: f.fromEmail };
  }
  if (item.kind === "linear") {
    return { key, text: item.title, source: "linear", project: item.issue.project?.name };
  }
  const action = item.change.source === "actions" && item.change.entityId ? actionsById?.get(item.change.entityId) : undefined;
  if (action) return actionSubject(action);
  return { key, text: [item.title, item.subtitle].filter(Boolean).join(" — "), source: item.change.source };
}

export function stampFeed<T extends TodayFeedItem>(items: readonly T[], placed: ReadonlyMap<string, Placed>): T[] {
  return items.map((i) => {
    const p = placed.get(feedKey(i));
    return p ? { ...i, workstream: p.workstream, workstreamBy: p.by } : i;
  });
}

export function stampActions<T extends Pick<ActionItem, "id">>(actions: readonly T[], placed: ReadonlyMap<string, Placed>): Array<T & { workstream?: Workstream | null; workstreamBy?: WorkstreamBy }> {
  return actions.map((a) => {
    const p = placed.get(actionKey(a.id));
    return p ? { ...a, workstream: p.workstream, workstreamBy: p.by } : a;
  });
}

export type WorkstreamTotals = Record<Workstream | "unsorted", number>;

/** Counts per workstream ("unsorted" = no workstream yet, or fits none). */
export function workstreamTotals(items: ReadonlyArray<{ workstream?: Workstream | null }>): WorkstreamTotals {
  const t = Object.fromEntries([...WORKSTREAM_IDS, "unsorted"].map((k) => [k, 0])) as WorkstreamTotals;
  for (const i of items) t[i.workstream ?? "unsorted"]++;
  return t;
}
