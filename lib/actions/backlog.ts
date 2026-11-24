/**
 * lib/actions/backlog.ts — open items nobody has touched for 30+ days
 * (audit 2026-11-24, Part 3 entry 15). Pure, shared by the Actions page's
 * "Untouched 30+ days" filter and the Friday wrap. These are cleared in one
 * tap each (done / new date / delete) rather than chased.
 */
export const BACKLOG_DAYS = 30;

export function isBacklog(a: { status: string; lastActivityAt?: string; updatedAt?: string; createdAt?: string }, now = Date.now()): boolean {
  if (a.status === "done") return false;
  const t = Date.parse(a.lastActivityAt ?? a.updatedAt ?? a.createdAt ?? "");
  return Number.isFinite(t) && now - t >= BACKLOG_DAYS * 86_400_000;
}
