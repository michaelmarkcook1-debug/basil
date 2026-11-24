/**
 * lib/notify/urgent-rules.ts — what is urgent enough to push the moment it
 * arrives (audit 2026-11-24, Part 3 entry 10). Pure; lib/notify/urgent.ts sends.
 *
 * Real-time webhooks (Gmail, Slack, Teams) classified every message as it came
 * in but told nobody: an urgent legal email waited for the next morning's
 * briefing. Now a new action from such a message is pushed when:
 *   - the classifier called it high urgency with confidence ≥ 0.7 and it asks
 *     something of the user (action / decision / escalation / blocker); or
 *   - it is about legal, money or investors (see SENSITIVE) at medium urgency
 *     or more with confidence ≥ 0.6;
 * and only for a message under 3 hours old (never a backfill), inside the
 * user's working hours, on a working day they are not away, at most
 * DAILY_CAP a day, each message once.
 */

export const DAILY_CAP = 5;
export const MAX_AGE_MS = 3 * 3_600_000;

const ASKS = new Set([
  "action_required", "decision_request", "follow_up_needed", // email
  "action_assigned", "action_identified", "decision_needed", "blocker_raised", "escalation", // slack / teams
]);

/** Legal, money, investors — the things that must not wait for tomorrow. */
export const SENSITIVE = /\b(legal|lawsuit|litigation|solicitor|attorney|lawyer|subpoena|breach|cease and desist|nda|indemnit\w*|invoice overdue|overdue invoice|payment (?:failed|declined|bounced)|chargeback|wire transfer|bank details|payroll|investor|term sheet|due diligence|board meeting|acquisition|resign\w*|data breach|security incident)\b/i;

export interface UrgentSignal {
  source: "email" | "slack" | "teams";
  urgency: "high" | "medium" | "low";
  category: string;
  confidence: number;
  /** Who sent it (name or address). */
  from: string;
  /** Subject / channel line and the gist, for the sensitivity check and the push body. */
  text: string;
  /** The action Basil created from it. */
  actionText: string;
  /** Stable id of the message (gmail:…, slack:…) — each one pushes once. */
  ref: string;
  /** When the message was sent (ISO). */
  date: string;
  /** Slack/Teams: a DM or a message addressed to the user. Channel chatter never pushes. */
  addressed?: boolean;
}

export function isUrgent(s: UrgentSignal): boolean {
  if (s.source !== "email" && s.addressed === false) return false;
  if (s.urgency === "high" && s.confidence >= 0.7 && ASKS.has(s.category)) return true;
  return s.urgency !== "low" && s.confidence >= 0.6 && SENSITIVE.test(`${s.text} ${s.actionText}`);
}

export function isFresh(dateIso: string, now = Date.now()): boolean {
  const t = Date.parse(dateIso);
  return Number.isFinite(t) && now - t <= MAX_AGE_MS && t <= now + 5 * 60_000;
}

const minutes = (hhmm: string | undefined, fallback: number) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

/** Inside the user's working hours (workStart ≤ now < workEnd, their time zone). */
export function inWorkingHours(now: number, tz: string, workStart?: string, workEnd?: string): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const at = h * 60 + m;
  const start = minutes(workStart, 9 * 60);
  const end = minutes(workEnd, 18 * 60);
  return end > start ? at >= start && at < end : at >= start || at < end;
}

const SOURCE_LABEL: Record<UrgentSignal["source"], string> = { email: "Email", slack: "Slack", teams: "Teams" };

export function urgentNotification(s: UrgentSignal): { kind: "urgent"; title: string; body: string; url: string; tag: string } {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const who = s.from.replace(/\s*<[^>]*>\s*$/, "").trim() || "Someone";
  return {
    kind: "urgent",
    title: clip(`Urgent · ${SOURCE_LABEL[s.source]} from ${who}`, 80),
    body: clip(s.actionText || s.text, 160),
    url: "/dashboard",
    tag: `urgent:${s.ref}`,
  };
}
