import "server-only";
import { z } from "zod";
import type { ActionItem } from "@/lib/types/action";
import { listActions, bulkUpdateActions } from "@/lib/actions/store";
import { getThreadState } from "@/lib/google/gmail";
import { getSlackUserClientForUser } from "@/lib/slack/client";
import { loadKnownSenders } from "@/lib/email/known-senders";
import { getSettings } from "@/lib/settings/store";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { isCalendarInvitation } from "@/lib/email/triage";

/**
 * Close actions whose conversation has moved on.
 *
 * Until 2026-09-26 the only closer was "did the user send a reply?" — anchored
 * on when the ACTION was created (so a reply sent before the daily 05:45 run was
 * never counted), capped at 10, and email-only. Nothing noticed a colleague
 * answering the question on a reply-all, the requester saying "sorted, ignore
 * this", or Slack threads at all. Those items sat on the Action Tracker forever.
 *
 * Per open email/Slack action, re-read the whole conversation after the source
 * message:
 *   - the user posted/replied            → done, "reply-sent"
 *   - the source was bulk/marketing mail  → done, "bulk-mail"
 *   - someone else replied                → ask a small model whether the user
 *                                           STILL needs to act; close only on a
 *                                           clear no ("answered-elsewhere")
 *   - nothing new                         → untouched
 *
 * The dangerous direction is closing work that is still the user's (the
 * three-state rule in basil-outbound-blindness): the judge defaults to "still
 * needed" on any doubt, error or unparseable answer.
 */

export const RECHECK_AFTER_HOURS = 20;
export const MAX_PER_RUN = 40;

export type ThreadResolution =
  | { kind: "reply-sent"; at: string; counterpart: string; subject: string }
  | { kind: "bulk-mail" }
  | { kind: "calendar-invite" }
  | { kind: "answered-elsewhere"; by: string; at: string; reason: string }
  | { kind: "open" };

export interface LaterMessage { from: string; date: string; text: string; self: boolean }

export interface ConversationView {
  /** Who sent the source message, and what it said. */
  original: { from: string; date: string; text: string };
  later: LaterMessage[];
  subject: string;
  bulk: boolean;
}

// ── The judge ────────────────────────────────────────────────────────────────

const VerdictSchema = z.object({
  stillNeeded: z.boolean(),
  answeredBy: z.string().optional().default(""),
  reason: z.string().optional().default(""),
});

export type Judge = (input: {
  firstName: string;
  ask: string;
  view: ConversationView;
}) => Promise<{ stillNeeded: boolean; answeredBy: string; reason: string }>;

export function judgePrompt(firstName: string, ask: string, view: ConversationView): string {
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 500);
  return `An item on ${firstName}'s to-do list was created from a message. Later messages in the same conversation follow. Decide whether ${firstName} STILL needs to act on the item.

Answer stillNeeded=false ONLY when a later message clearly shows the item is settled without ${firstName}: someone else answered the question or did the task, the requester withdrew it or said it is sorted, or the thing was decided or scheduled without them.
Answer stillNeeded=true if a later message still asks ${firstName} for something, if it only acknowledges or adds information, or if you are unsure.

To-do item: ${clip(ask)}
Original message from ${view.original.from} (${view.original.date.slice(0, 10)}): ${clip(view.original.text)}
Later messages:
${view.later.map((m) => `- ${m.from} (${m.date.slice(0, 10)}): ${clip(m.text)}`).join("\n")}

Respond with JSON only: {"stillNeeded": true or false, "answeredBy": "name or empty", "reason": "one short sentence"}`;
}

export function makeModelJudge(username: string): Judge {
  return async ({ firstName, ask, view }) => {
    try {
      const { text } = await generateTextSafe({
        model: getTextModel("fast"),
        maxOutputTokens: 200,
        system: "You judge whether a to-do item is still outstanding. Be conservative: when in doubt, it is still needed.",
        prompt: judgePrompt(firstName, ask, view),
      }, "fast", { username, feature: "resolve:thread" });
      const parsed = parseAndValidate(text, VerdictSchema, "[resolve-threads]");
      return parsed.ok ? parsed.data : { stillNeeded: true, answeredBy: "", reason: "" };
    } catch (err) {
      // Keeping the item open is the safe answer; say why, so a broken judge is visible.
      console.warn("[resolve-threads] judge failed, keeping the item open:", err instanceof Error ? err.message : err);
      return { stillNeeded: true, answeredBy: "", reason: "" };
    }
  };
}

/** Pure decision over a conversation — exported for tests. */
export async function decide(
  action: Pick<ActionItem, "text">,
  view: ConversationView,
  judge: Judge,
  firstName: string,
): Promise<ThreadResolution> {
  const mine = view.later.find((m) => m.self);
  if (mine) return { kind: "reply-sent", at: mine.date, counterpart: view.original.from, subject: view.subject };
  if (view.bulk) return { kind: "bulk-mail" };
  if (isCalendarInvitation(view.subject)) return { kind: "calendar-invite" };
  const others = view.later.filter((m) => !m.self && m.text.trim());
  if (others.length === 0) return { kind: "open" };
  const verdict = await judge({ firstName, ask: action.text, view: { ...view, later: others } });
  if (verdict.stillNeeded) return { kind: "open" };
  const last = others[others.length - 1];
  return { kind: "answered-elsewhere", by: verdict.answeredBy || last.from, at: last.date, reason: verdict.reason };
}

// ── Reading the conversations ────────────────────────────────────────────────

export type ViewLoader = (action: ActionItem) => Promise<ConversationView | null>;

async function gmailLoader(username: string): Promise<ViewLoader> {
  const known = await loadKnownSenders(username);
  return async (action) => {
    const id = action.sourceRef?.slice("gmail:".length);
    if (!id) return null;
    const t = await getThreadState(username, id);
    if (!t) return null;
    const promo = t.original.labels.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_SOCIAL");
    return {
      subject: t.subject,
      bulk: (t.original.bulk || promo) && !known.isKnown(t.original.fromEmail),
      original: { from: t.original.fromName, date: t.original.date, text: t.original.snippet },
      later: t.later.map((m) => ({ from: m.fromName, date: m.date, text: m.snippet, self: m.sent })),
    };
  };
}

type SlackMsg = { user?: string; text?: string; ts?: string; subtype?: string; bot_id?: string };

async function slackLoader(username: string): Promise<ViewLoader | null> {
  const web = await getSlackUserClientForUser(username);
  if (!web) return null;
  let selfId: string | undefined;
  try { selfId = ((await web.auth.test()) as { user_id?: string }).user_id; } catch { return null; }
  if (!selfId) return null;
  const names = new Map<string, string>();
  const nameOf = async (user?: string) => {
    if (!user) return "Someone";
    if (!names.has(user)) {
      try {
        const info = (await web.users.info({ user })) as { user?: { real_name?: string; name?: string } };
        names.set(user, info.user?.real_name || info.user?.name || "Someone");
      } catch { names.set(user, "Someone"); }
    }
    return names.get(user)!;
  };
  return async (action) => {
    const [, channel, ts] = (action.sourceRef ?? "").split(":");
    if (!channel || !ts) return null;
    // Thread replies always count. In DMs and group DMs people answer inline,
    // so the messages after it count too; in channels those are unrelated chatter.
    let direct = false;
    try {
      const info = (await web.conversations.info({ channel })) as { channel?: { is_im?: boolean; is_mpim?: boolean } };
      direct = !!(info.channel?.is_im || info.channel?.is_mpim);
    } catch { direct = channel.startsWith("D"); }
    const byTs = new Map<string, SlackMsg>();
    try {
      const r = (await web.conversations.replies({ channel, ts, limit: 50 })) as { messages?: SlackMsg[] };
      for (const m of r.messages ?? []) if (m.ts) byTs.set(m.ts, m);
    } catch { /* not a thread */ }
    if (direct) {
      try {
        const h = (await web.conversations.history({ channel, oldest: ts, inclusive: true, limit: 30 })) as { messages?: SlackMsg[] };
        for (const m of h.messages ?? []) if (m.ts) byTs.set(m.ts, m);
      } catch { /* history unavailable */ }
    }
    const original = byTs.get(ts);
    if (!original) return null;
    const later = [...byTs.values()]
      .filter((m) => m.ts && parseFloat(m.ts) > parseFloat(ts) && !m.subtype && !m.bot_id && (m.text ?? "").trim())
      .sort((a, b) => parseFloat(a.ts!) - parseFloat(b.ts!));
    const iso = (t: string) => new Date(parseFloat(t) * 1000).toISOString();
    return {
      subject: "Slack",
      bulk: false,
      original: { from: await nameOf(original.user), date: iso(ts), text: original.text ?? "" },
      later: await Promise.all(later.map(async (m) => ({
        from: await nameOf(m.user), date: iso(m.ts!), text: m.text ?? "", self: m.user === selfId,
      }))),
    };
  };
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface ResolveResult {
  checked: number;
  closed: Array<{ action: ActionItem; resolution: Exclude<ThreadResolution, { kind: "open" }> }>;
}

export function dueForCheck(a: ActionItem, now = Date.now()): boolean {
  if (a.status !== "open" && a.status !== "overdue") return false;
  const ref = a.sourceRef ?? "";
  const kind = a.source === "email" && ref.startsWith("gmail:") ? "email"
    : a.source === "slack" && ref.startsWith("slack:") ? "slack" : null;
  if (!kind) return false;
  if (a.threadCheckedAt && now - new Date(a.threadCheckedAt).getTime() < RECHECK_AFTER_HOURS * 3_600_000) return false;
  return true;
}

export async function resolveThreadActions(
  username: string,
  deps: { judge?: Judge; loaders?: { email?: ViewLoader | null; slack?: ViewLoader | null }; max?: number } = {},
): Promise<ResolveResult> {
  const now = new Date().toISOString();
  const due = (await listActions(username, { fresh: true }))
    .filter((a) => dueForCheck(a))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, deps.max ?? MAX_PER_RUN);
  if (due.length === 0) return { checked: 0, closed: [] };

  const [email, slack] = await Promise.all([
    deps.loaders && "email" in deps.loaders ? deps.loaders.email ?? null
      : due.some((a) => a.source === "email") ? gmailLoader(username) : null,
    deps.loaders && "slack" in deps.loaders ? deps.loaders.slack ?? null
      : due.some((a) => a.source === "slack") ? slackLoader(username) : null,
  ]);
  const judge = deps.judge ?? makeModelJudge(username);
  const settings = await getSettings(username).catch((err) => {
    console.warn("[resolve-threads] settings unavailable, using username:", err instanceof Error ? err.message : err);
    return null;
  });
  const firstName = (settings?.name ?? username).split(" ")[0];

  const closed: ResolveResult["closed"] = [];
  const updates: Array<{ id: string; patch: Partial<ActionItem> }> = [];
  for (const action of due) {
    const load = action.source === "email" ? email : slack;
    let view: ConversationView | null = null;
    try { view = load ? await load(action) : null; } catch (err) {
      console.warn(`[resolve-threads] could not read the conversation for ${action.id}:`, err instanceof Error ? err.message : err);
      view = null;
    }
    if (!view) { updates.push({ id: action.id, patch: { threadCheckedAt: now } }); continue; }
    const r = await decide(action, view, judge, firstName);
    if (r.kind === "open") { updates.push({ id: action.id, patch: { threadCheckedAt: now } }); continue; }
    const note =
      r.kind === "reply-sent" ? `Closed: you replied on ${r.at.slice(0, 10)}.`
      : r.kind === "bulk-mail" ? "Closed: this came from marketing or list mail."
      : r.kind === "calendar-invite" ? "Closed: a calendar invitation — answer it on your calendar."
      : `Closed: ${r.by} replied on ${r.at.slice(0, 10)}${r.reason ? ` — ${r.reason}` : ""}.`;
    updates.push({
      id: action.id,
      patch: {
        status: "done",
        archivedReason: r.kind,
        threadCheckedAt: now,
        lastActivityAt: r.kind === "bulk-mail" || r.kind === "calendar-invite" ? now : r.at,
        notes: action.notes ? `${action.notes}\n${note}` : note,
      },
    });
    closed.push({ action, resolution: r });
  }
  await bulkUpdateActions(username, updates);
  if (closed.length) console.log(`[resolve-threads] ${username}: checked ${due.length}, closed ${closed.length} (${closed.map((c) => c.resolution.kind).join(", ")})`);
  return { checked: due.length, closed };
}
