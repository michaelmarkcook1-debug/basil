/**
 * What Basil tells the user without being asked (2026-11-10), as pure rules.
 *
 * Before this, Basil only spoke when opened: a follow-up date passed without a
 * word, and a revoked Slack token showed up as a quiet inbox until the user
 * noticed messages were missing. These rules decide what to send; lib/notify/
 * index.ts sends it. Tested in tests/notify.test.mjs.
 */
import type { ActionItem } from "@/lib/types/action";
import { isWaitingOnOthers } from "@/lib/actions/utils";

export type NotifyKind = "briefing" | "reminders" | "connections" | "test";

export interface NotifyPrefs {
  /** Today's briefing is ready. */
  briefing: boolean;
  /** Follow-up dates and due dates, once each, at the start of the working day. */
  reminders: boolean;
  /** A connection (Slack, Gmail, Calendar…) stopped working and needs reconnecting. */
  connections: boolean;
  /** Email a reminder when no device has notifications turned on. Connection alerts always fall back to email. */
  emailReminders: boolean;
}

export const DEFAULT_PREFS: NotifyPrefs = { briefing: true, reminders: true, connections: true, emailReminders: false };

export interface Notification {
  kind: NotifyKind;
  title: string;
  body: string;
  /** Path inside Basil the notification opens. */
  url: string;
  /** Same tag replaces an earlier notification on the device instead of stacking. */
  tag: string;
}

export interface Reminder {
  id: string;
  text: string;
  /** Why it is due today. */
  reason: "follow-up" | "due-today" | "overdue";
  /** The date that fired it; part of the once-only key, so a new date reminds again. */
  date: string;
}

/** Calendar day of a stored date ("2026-11-10" or an ISO timestamp) in the user's time zone. */
export function localDay(value: string | undefined, tz: string): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * The user's own open actions that come due today: a follow-up date today or
 * earlier, a due date today, or a due date that has passed. Someone else's
 * commitment is something the user is waiting on, not a reminder for them;
 * an unconfirmed extraction is not a fact yet.
 */
export function dueReminders(actions: readonly ActionItem[], today: string, tz: string, selfNames: readonly string[]): Reminder[] {
  const out: Reminder[] = [];
  for (const a of actions) {
    if (a.status === "done" || a.needsReview) continue;
    if (isWaitingOnOthers(a, selfNames)) continue;
    const follow = localDay(a.followUpDate, tz);
    const due = localDay(a.dueDate, tz);
    // Marked ongoing: no overdue nagging, just the weekly check-in.
    if (a.ongoing) {
      if (follow && follow <= today) out.push({ id: a.id, text: a.text, reason: "follow-up", date: follow });
      continue;
    }
    if (due && due < today) out.push({ id: a.id, text: a.text, reason: "overdue", date: due });
    else if (due === today) out.push({ id: a.id, text: a.text, reason: "due-today", date: due });
    else if (follow && follow <= today) out.push({ id: a.id, text: a.text, reason: "follow-up", date: follow });
  }
  const order = { overdue: 0, "due-today": 1, "follow-up": 2 } as const;
  return out.sort((x, y) => order[x.reason] - order[y.reason] || x.date.localeCompare(y.date));
}

/** The once-only key for a reminder: the same action reminds again only when its date changes. */
export function reminderKey(r: Reminder): string {
  return `reminder:${r.id}:${r.reason === "follow-up" ? "f" : "d"}:${r.date}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One notification for the morning's reminders, never one per action. */
export function reminderNotification(reminders: readonly Reminder[]): Notification | null {
  if (reminders.length === 0) return null;
  const overdue = reminders.filter((r) => r.reason === "overdue").length;
  const first = reminders[0];
  const lead = first.reason === "overdue" ? "Overdue" : first.reason === "due-today" ? "Due today" : "Follow up";
  const title = reminders.length === 1
    ? `${lead}: ${clip(first.text, 60)}`
    : `${reminders.length} things to pick up today${overdue ? ` (${overdue} overdue)` : ""}`;
  const body = reminders.length === 1
    ? "Open Basil to mark it done or move the date."
    : reminders.slice(0, 3).map((r) => `• ${clip(r.text, 70)}`).join("\n") + (reminders.length > 3 ? `\n…and ${reminders.length - 3} more` : "");
  return { kind: "reminders", title, body, url: "/dashboard/actions", tag: "basil-reminders" };
}

export interface ConnectionHealth {
  slackTokenInvalid?: boolean;
  lastPollErrors?: Record<string, { message: string; fatal: boolean }>;
}

const SOURCE_LABELS: Record<string, string> = {
  slack: "Slack", email: "Gmail", gmail: "Gmail", calendar: "Google Calendar", google: "Google",
  zoom_email: "Zoom", zoom: "Zoom", outlook_email: "Outlook", outlook: "Outlook", teams: "Microsoft Teams",
  microsoft: "Microsoft 365", linear: "Linear", drive: "Google Drive",
};

/** Connections that need the user to sign in again. Transient errors (rate limits, timeouts) are not listed. */
export function brokenConnections(health: ConnectionHealth): { source: string; label: string }[] {
  const out = new Map<string, string>();
  if (health.slackTokenInvalid) out.set("slack", "Slack");
  for (const [source, err] of Object.entries(health.lastPollErrors ?? {})) {
    if (err?.fatal) out.set(source, SOURCE_LABELS[source] ?? source);
  }
  return [...out].map(([source, label]) => ({ source, label }));
}

export function connectionNotification(broken: readonly { label: string }[]): Notification | null {
  if (broken.length === 0) return null;
  const names = broken.map((b) => b.label);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return {
    kind: "connections",
    title: `${list} stopped working`,
    body: `Basil can't read ${list} until you reconnect. Until then it looks like a quiet inbox, but it isn't.`,
    url: "/dashboard/settings?tab=sources",
    tag: "basil-connections",
  };
}

/** The first line of the briefing's "Critical today", short enough for a lock screen. */
export function briefingTeaser(b: { criticalToday?: string | null }): string {
  const line = (b.criticalToday ?? "")
    .split("\n")
    .map((l) => l.replace(/[*_#`>]/g, "").replace(/^\s*(?:[-•]|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0) ?? "";
  if (!line) return "Open Basil to see what needs you today.";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** "09:00" → 9. Falls back to 9 for anything unreadable. */
export function startHour(workStart: string | undefined): number {
  const m = /^(\d{1,2})(?::\d{2})?$/.exec((workStart ?? "").trim());
  const h = m ? Number(m[1]) : NaN;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}

/** The hour of day (0–23) in a time zone. */
export function hourIn(ms: number, tz: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(ms);
  return Number(h) % 24;
}
