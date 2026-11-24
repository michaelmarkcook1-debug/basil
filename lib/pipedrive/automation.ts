/**
 * lib/pipedrive/automation.ts — the user's opt-in for Pipedrive follow-ups.
 *
 *   off      — Basil reads Pipedrive for context only.
 *   suggest  — (default) suggested follow-ups on Today and in the briefing.
 *   alert    — also a notification at the start of the working day listing new ones.
 *   schedule — also "Find a time" on each suggestion: Basil checks both
 *              calendars, offers slots, and books the follow-up meeting with
 *              the CRM context as its agenda and meeting prep ready — only when
 *              the user picks a slot. Nothing is ever sent without that click.
 *
 * One small per-user file, `pipedrive-automation.json`.
 */
import "server-only";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";

export type FollowupMode = "off" | "suggest" | "alert" | "schedule";
export const FOLLOWUP_MODES: readonly FollowupMode[] = ["off", "suggest", "alert", "schedule"];

export interface PipedriveAutomation {
  mode: FollowupMode;
  /** Days without an update before an open deal counts as going cold. */
  staleDays: number;
  /** Length of a booked follow-up meeting. */
  meetingMinutes: number;
  /** Suggestion id → ISO date dismissed. */
  dismissed: Record<string, string>;
  /** Suggestion id → the event Basil booked for it. */
  booked: Record<string, { eventId: string; at: string; start: string }>;
}

const FILE = "pipedrive-automation.json";
export const DEFAULT_AUTOMATION: PipedriveAutomation = { mode: "suggest", staleDays: 14, meetingMinutes: 30, dismissed: {}, booked: {} };

function clean(s: Partial<PipedriveAutomation> | null): PipedriveAutomation {
  return {
    mode: FOLLOWUP_MODES.includes(s?.mode as FollowupMode) ? (s!.mode as FollowupMode) : DEFAULT_AUTOMATION.mode,
    staleDays: Number.isFinite(s?.staleDays) ? Math.min(90, Math.max(3, Math.round(s!.staleDays!))) : DEFAULT_AUTOMATION.staleDays,
    meetingMinutes: [15, 30, 45, 60].includes(s?.meetingMinutes as number) ? s!.meetingMinutes! : DEFAULT_AUTOMATION.meetingMinutes,
    dismissed: s?.dismissed && typeof s.dismissed === "object" ? s.dismissed : {},
    booked: s?.booked && typeof s.booked === "object" ? s.booked : {},
  };
}

export async function readAutomation(username: string): Promise<PipedriveAutomation> {
  return clean(await readUserStore<Partial<PipedriveAutomation> | null>(username, FILE, null, { fresh: true }));
}

export async function updateAutomation(username: string, patch: (cur: PipedriveAutomation) => Partial<PipedriveAutomation>): Promise<PipedriveAutomation> {
  return clean(await updateUserStore<Partial<PipedriveAutomation> | null>(username, FILE, (cur) => {
    const c = clean(cur);
    const next = { ...c, ...patch(c) };
    // Keep the bookkeeping small.
    const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
    next.dismissed = Object.fromEntries(Object.entries(next.dismissed).filter(([, at]) => at >= cutoff));
    next.booked = Object.fromEntries(Object.entries(next.booked).filter(([, b]) => b.at >= cutoff));
    return next;
  }, null, { allowShrink: true }));
}
