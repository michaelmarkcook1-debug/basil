/**
 * lib/actions/chasers.ts — things the user is waiting on that have gone quiet
 * (audit 2026-11-24, Part 3 entry 14). Pure; app/api/cron/reminders sends.
 *
 * An open action owned by someone else (delegated, or its owner is not the
 * user) that has waited 5–30 days and seen nothing for 3+ days is chased: once a
 * week per item, at most 3 a morning, with a short draft chaser queued for
 * approval when Basil knows the person's address. The draft is a template the
 * user edits — no AI call — and nothing is sent without their yes.
 */
import type { ActionItem } from "@/lib/types/action";
import { isWaitingOnOthers } from "@/lib/actions/utils";

export const MIN_WAIT_DAYS = 5;
export const MIN_QUIET_DAYS = 3;
/** Older than this is backlog for the Friday clean-up, not a live chase. */
export const MAX_WAIT_DAYS = 30;
export const MAX_PER_DAY = 3;

const DAY = 86_400_000;
const daysSince = (iso: string | undefined, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : 0;
};

export interface Chase { action: ActionItem; who: string; days: number }

export function chaseCandidates(actions: readonly ActionItem[], selfNames: readonly string[], now = Date.now()): Chase[] {
  const out: Chase[] = [];
  for (const a of actions) {
    if (a.status === "done" || a.needsReview) continue;
    const who = (a.delegatedTo || a.owner || "").trim();
    if (!who || !(a.delegatedTo || isWaitingOnOthers(a, selfNames))) continue;
    const days = daysSince(a.delegatedAt ?? a.createdAt, now);
    const quiet = daysSince(a.lastActivityAt ?? a.updatedAt ?? a.createdAt, now);
    if (days < MIN_WAIT_DAYS || days > MAX_WAIT_DAYS || quiet < MIN_QUIET_DAYS) continue;
    out.push({ action: a, who, days });
  }
  return out.sort((x, y) => y.days - x.days);
}

/** Once a week per item: the key changes every 7 days. */
export function chaseKey(actionId: string, now = Date.now()): string {
  return `chase:${actionId}:w${Math.floor(now / (7 * DAY))}`;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const first = (name: string) => name.trim().split(/\s+/)[0] || name;

/** The draft chaser — short, specific, easy to edit. */
export function chaserDraft(c: Chase, userFirstName: string): { subject: string; body: string } {
  const task = c.action.text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  return {
    subject: `Following up: ${clip(task, 60)}`,
    body: `Hi ${first(c.who)},\n\nJust checking in on ${task.charAt(0).toLowerCase()}${task.slice(1)}. Any update, or anything you need from me?\n\nThanks,\n${userFirstName}`,
  };
}

export function chaseNotification(list: readonly Chase[]): { kind: "reminders"; title: string; body: string; url: string; tag: string } | null {
  if (!list.length) return null;
  const line = (c: Chase) => `${first(c.who)}: ${clip(c.action.text, 60)} (${c.days} days)`;
  return {
    kind: "reminders",
    title: list.length === 1 ? `${first(list[0].who)} owes you something, ${list[0].days} days` : `Waiting on ${list.length} people`,
    body: clip(list.map(line).join("; "), 180) + " Chasers drafted where Basil has an address.",
    url: "/dashboard/actions",
    tag: "basil-chasers",
  };
}
