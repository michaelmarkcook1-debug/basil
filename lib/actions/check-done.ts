/**
 * Close the user's asks that are already done, or whose moment has passed
 * (2026-11-13).
 *
 * resolve-threads.ts re-reads the SOURCE conversation of email and Slack
 * actions. That misses most of how work actually gets finished:
 *   • actions from meetings, chat or typed by hand have no thread to re-read;
 *   • the user often delivers somewhere else: a fresh email to the person, a
 *     Slack DM, a message in a channel;
 *   • some asks stop making sense once their date has gone ("confirm the move
 *     to Thu 12 Nov", "wrap up before the honeymoon").
 * On 2026-11-13 Today's "You promised" showed four such items as overdue.
 *
 * Per open action of the user's own: gather what the user sent since it was
 * created (email and Slack, to anyone), keep the messages that plausibly relate
 * to it, and ask a small model for one of three answers: done, expired, open.
 * The dangerous direction is closing live work (basil-outbound-blindness), so
 * anything short of clear evidence, any error and any unreadable answer is
 * "open". Every close leaves a note saying why, and can be reopened.
 */
import "server-only";
import { z } from "zod";
import type { ActionItem } from "@/lib/types/action";
import { isWaitingOnOthers } from "@/lib/actions/utils";
import { fromOwnSlackMessage, fromSentEmail, type OutboundEvent } from "@/lib/briefing/outbound-evidence";
import { listActions, bulkUpdateActions } from "@/lib/actions/store";
import { getSentEmails } from "@/lib/google/gmail";
import { getRecentSlackMessages } from "@/lib/slack/client";
import { getSelfIdentity } from "@/lib/self-identity";
import { getSettings } from "@/lib/settings/store";
import { getWorkCalendar } from "@/lib/away/store";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";

export const DONE_CHECK_AFTER_HOURS = 20;
export const MAX_DONE_CHECKS = 40;

export interface DoneVerdict {
  state: "done" | "expired" | "open";
  reason: string;
  /** Which message showed it (for the note). */
  evidence?: string;
}

export const VerdictSchema = z.object({
  state: z.enum(["done", "expired", "open"]),
  reason: z.string().optional().default(""),
  evidence: z.string().optional().default(""),
});

/** Open, the user's own, confirmed, and not checked in the last day. */
export function dueForDoneCheck(a: ActionItem, selfNames: readonly string[], now = Date.now()): boolean {
  if (a.status === "done" || a.needsReview) return false;
  if (isWaitingOnOthers(a, selfNames)) return false;
  const checked = a.doneCheckedAt ? Date.parse(a.doneCheckedAt) : NaN;
  return !(Number.isFinite(checked) && now - checked < DONE_CHECK_AFTER_HOURS * 3_600_000);
}

const STOP = new Set(("the and for with from that this have will your about into their them they what when where which while "
  + "would could should there here been being after before again also just only than then some more most other such very "
  + "send sent reply respond confirm review check update follow make sure need needs please today tomorrow week").split(" "));

/** Words that carry the ask's meaning: lower-case, 4+ letters, not filler. */
export function keywords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

const NOT_NAMES = new Set(["the", "send", "review", "confirm", "wrap", "reply", "follow", "check", "update", "ask", "share", "book", "schedule",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "am", "pm"]);

/**
 * Capitalised words that look like names or products ("Ed", "Malcolm Frank",
 * "Exec Genius"). The user's own names are left out: every message they send
 * is signed with them, so they match everything.
 */
export function properNouns(text: string, selfNames: readonly string[] = []): Set<string> {
  const self = new Set(selfNames.flatMap((n) => n.toLowerCase().split(/\s+/)).filter(Boolean));
  const out = new Set<string>();
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]{1,}\b/g)) {
    const w = m[0].toLowerCase();
    if (!NOT_NAMES.has(w) && !self.has(w)) out.add(w);
  }
  return out;
}

/**
 * The user's messages since the action appeared that plausibly concern it:
 * they name someone or something the action names, or share two of its
 * meaningful words. Most relevant first.
 */
export function evidenceFor(action: Pick<ActionItem, "text" | "createdAt" | "owner">, events: readonly OutboundEvent[], max = 6, selfNames: readonly string[] = []): OutboundEvent[] {
  const since = Date.parse(action.createdAt) - 3_600_000;
  const words = keywords(action.text);
  const names = properNouns(action.text, selfNames);
  const scored: { e: OutboundEvent; score: number }[] = [];
  for (const e of events) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < since) continue;
    const hay = `${e.to} ${e.subject} ${e.text}`.toLowerCase();
    let nameHits = 0;
    for (const n of names) if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)) nameHits++;
    let wordHits = 0;
    for (const w of words) if (hay.includes(w)) wordHits++;
    const score = nameHits * 2 + wordHits + (e.explicitlyDone ? 1 : 0);
    if (nameHits > 0 || wordHits >= 2) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.e.at.localeCompare(a.e.at)).slice(0, max).map((s) => s.e);
}

export function doneCheckPrompt(input: {
  firstName: string;
  today: string;
  action: Pick<ActionItem, "text" | "createdAt" | "dueDate" | "source">;
  evidence: readonly OutboundEvent[];
  absences: readonly string[];
}): string {
  const clip = (s: string, n = 400) => s.replace(/\s+/g, " ").trim().slice(0, n);
  const { firstName, today, action, evidence, absences } = input;
  return `Today is ${today}. This is on ${firstName}'s to-do list (created ${action.createdAt.slice(0, 10)} from ${action.source}${action.dueDate ? `, due ${action.dueDate.slice(0, 10)}` : ""}):
"${clip(action.text)}"

${absences.length ? `${firstName}'s time away: ${absences.join("; ")}.\n\n` : ""}Messages ${firstName} has sent since it was created that may be related:
${evidence.length ? evidence.map((e, i) => `${i + 1}. ${e.at.slice(0, 10)} ${e.channel} to ${clip(e.to, 80)}: ${clip(e.subject, 120)} | ${clip(e.text)}`).join("\n") : "(none)"}

Answer one of:
- "done": a message above clearly shows ${firstName} did it (sent the thing, gave the answer, confirmed the change), or told someone it is done.
- "expired": the item is tied to a specific date or event that has clearly passed, so doing it now would make no sense (a meeting or deadline that is over, "before" a trip that has started or ended).
- "open": anything else, including messages that only discuss it, promise it, or that you are unsure about.
Being wrong with "done" or "expired" hides real work, so choose "open" whenever in doubt.

Respond with JSON only: {"state": "done" | "expired" | "open", "reason": "one short sentence", "evidence": "the message number and recipient, or empty"}`;
}

/** The note added when Basil closes an item, so the user can see why. */
export function closeNote(v: DoneVerdict, today: string): string {
  return v.state === "done"
    ? `Closed by Basil on ${today}: looks done${v.reason ? ` — ${v.reason}` : ""}${v.evidence ? ` (${v.evidence})` : ""}. Reopen it if not.`
    : `Closed by Basil on ${today}: the moment for this has passed${v.reason ? ` — ${v.reason}` : ""}. Reopen it if it still matters.`;
}

/** Patch for one verdict. Open → only the check time moves. */
export function patchFor(action: Pick<ActionItem, "notes">, v: DoneVerdict, nowIso: string): Partial<ActionItem> {
  if (v.state === "open") return { doneCheckedAt: nowIso };
  const note = closeNote(v, nowIso.slice(0, 10));
  return {
    status: "done",
    archivedReason: v.state === "done" ? "promise-kept" : "expired",
    closedByBasil: true,
    doneCheckedAt: nowIso,
    lastActivityAt: nowIso,
    notes: action.notes ? `${action.notes}\n${note}` : note,
  };
}


// ── The run ──────────────────────────────────────────────────────────────────

export type DoneJudge = (prompt: string) => Promise<DoneVerdict>;

export function makeDoneJudge(username: string): DoneJudge {
  return async (prompt) => {
    try {
      const { text } = await generateTextSafe({
        model: getTextModel("balanced"),
        maxOutputTokens: 200,
        system: "You decide whether a to-do item is finished. Be conservative: when in doubt, it is open.",
        prompt,
      }, "balanced", { username, feature: "actions:check-done" });
      const parsed = parseAndValidate(text, VerdictSchema, "[check-done]");
      return parsed.ok ? parsed.data : { state: "open", reason: "" };
    } catch (err) {
      console.warn("[check-done] judge failed, keeping the item open:", err instanceof Error ? err.message : err);
      return { state: "open", reason: "" };
    }
  };
}

/** Everything the user sent in the window, email and Slack. Each source is best-effort. */
export async function loadOutbound(username: string, days: number): Promise<OutboundEvent[]> {
  const [sent, slack] = await Promise.all([
    getSentEmails(username, 150, days).catch((e) => { console.warn("[check-done] sent mail unavailable:", e instanceof Error ? e.message : e); return []; }),
    getRecentSlackMessages(username, 1500, days).catch((e) => { console.warn("[check-done] Slack unavailable:", e instanceof Error ? e.message : e); return []; }),
  ]);
  return [
    ...sent.map(fromSentEmail),
    ...slack.filter((m) => m.fromSelf).map((m) => fromOwnSlackMessage({ channel: m.channel, text: m.text, date: m.date })),
  ];
}

export interface CheckDoneResult {
  checked: number;
  closed: { id: string; text: string; state: "done" | "expired"; reason: string }[];
}

export async function checkDoneActions(
  username: string,
  deps: { judge?: DoneJudge; outbound?: OutboundEvent[]; max?: number; now?: number } = {},
): Promise<CheckDoneResult> {
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const [actions, identity, settings] = await Promise.all([
    listActions(username, { fresh: true }),
    getSelfIdentity(username),
    getSettings(username).catch((e) => { console.warn("[check-done] settings unavailable:", e instanceof Error ? e.message : e); return null; }),
  ]);
  const due = actions
    .filter((a) => dueForDoneCheck(a, identity.names, now))
    .sort((a, b) => (a.doneCheckedAt ?? "").localeCompare(b.doneCheckedAt ?? "") || a.createdAt.localeCompare(b.createdAt))
    .slice(0, deps.max ?? MAX_DONE_CHECKS);
  if (due.length === 0) return { checked: 0, closed: [] };

  const oldest = Math.min(...due.map((a) => Date.parse(a.createdAt) || now));
  const days = Math.min(60, Math.max(3, Math.ceil((now - oldest) / 86_400_000) + 1));
  const [outbound, cal] = await Promise.all([
    deps.outbound ?? loadOutbound(username, days),
    getWorkCalendar(username).catch((e) => { console.warn("[check-done] working calendar unavailable:", e instanceof Error ? e.message : e); return null; }),
  ]);
  const absences = (cal?.away ?? [])
    .filter((p) => p.end >= new Date(now - 90 * 86_400_000).toISOString().slice(0, 10))
    .map((p) => `${p.start} to ${p.end}${p.label ? ` (${p.label})` : ""}`);
  const tz = settings?.timezone || "Europe/London";
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now);
  const firstName = (settings?.name || identity.names[0] || username).split(" ")[0];
  const judge = deps.judge ?? makeDoneJudge(username);

  const verdicts = new Map<string, DoneVerdict>();
  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(due.slice(i, i + 4).map(async (a) => {
      const evidence = evidenceFor(a, outbound, 6, identity.names);
      verdicts.set(a.id, await judge(doneCheckPrompt({ firstName, today, action: a, evidence, absences })));
    }));
  }

  const updates = due.map((a) => ({ id: a.id, patch: patchFor(a, verdicts.get(a.id) ?? { state: "open", reason: "" }, nowIso) }));
  await bulkUpdateActions(username, updates);
  const closed = due.flatMap((a) => {
    const v = verdicts.get(a.id);
    return v && v.state !== "open" ? [{ id: a.id, text: a.text, state: v.state, reason: v.reason }] : [];
  });
  if (closed.length) console.log(`[check-done] ${username}: checked ${due.length}, closed ${closed.length} (${closed.map((c) => c.state).join(", ")})`);
  return { checked: due.length, closed };
}
