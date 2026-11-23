/**
 * lib/followups/context.ts — what the user has done with a person since they wrote.
 *
 * "Needs you" used to close a card only when the user answered in the SAME
 * Gmail thread (or on the calendar, for an invitation). People answer by other
 * routes: a fresh email, a Slack DM, a meeting booked with the sender. Those
 * touches are collected here and handed to the needs-reply judge with the full
 * message, so it can tell "already dealt with" from "still waiting".
 *
 * Everything here is best-effort and never throws: missing context means the
 * judge sees less, never that a card is hidden by mistake.
 */
import "server-only";
import type { GmailMessage } from "@/lib/google/gmail";
import type { CalendarEvent } from "@/lib/google/calendar";

export interface Touch {
  channel: "email" | "slack" | "meeting";
  /** ISO time of the touch (meetings: when it starts). */
  at: string;
  text: string;
}

const MAX_TOUCHES = 5;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const lc = (s?: string) => (s ?? "").trim().toLowerCase();

/**
 * The newest message only: drop the quoted history ("On … wrote:", "-----Original
 * Message-----", "> " lines) and Outlook's "From: … Sent: …" block. Pure.
 */
export function latestMessageText(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) continue;
    if (/^\s*On .{4,200}wrote:\s*$/i.test(l)) break;
    // "On Thu, Nov 5, 2026 at 11:42 AM Guy Saunders <guy@…>" can wrap onto the next line.
    if (/^\s*On .{4,200}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] ?? "")) break;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i.test(l)) break;
    if (/^\s*From:\s.+/i.test(l) && lines.slice(i + 1, i + 4).some((n) => /^\s*(Sent|Date):\s/i.test(n))) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Mail the user sent to this address after `sinceIso`, in any thread. Pure. */
export function touchesFromSent(sent: readonly GmailMessage[], email: string | undefined, sinceIso: string): Touch[] {
  const who = lc(email);
  if (!who) return [];
  return sent
    .filter((m) => m.date > sinceIso && (lc(m.to).includes(who) || lc(m.cc).includes(who)))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_TOUCHES)
    .map((m) => ({ channel: "email" as const, at: m.date, text: clip(`${m.subject || "(no subject)"} — ${m.snippet || ""}`, 240) }));
}

/**
 * Meetings with this person that start after they wrote — a "can we catch up?"
 * that now has a meeting is answered. Declined meetings don't count. Pure.
 */
export function touchesFromEvents(events: readonly CalendarEvent[], email: string | undefined, sinceIso: string): Touch[] {
  const who = lc(email);
  if (!who) return [];
  return events
    .filter((e) => e.start > sinceIso && e.myResponseStatus !== "declined"
      && ((e.attendeeDetails ?? []).some((a) => lc(a.email) === who) || lc(e.organizerEmail) === who))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 3)
    .map((e) => ({ channel: "meeting" as const, at: e.start, text: clip(`${e.summary}${e.recurring ? " (repeating meeting)" : ""}`, 160) }));
}

// ── Slack ──────────────────────────────────────────────────────────────────

/** The few Slack Web API calls used here (a user-token WebClient satisfies it). */
export interface SlackLike {
  users: { list(a: { limit: number; cursor?: string }): Promise<unknown> };
  conversations: {
    list(a: { types: string; limit: number }): Promise<unknown>;
    history(a: { channel: string; oldest?: string; limit: number }): Promise<unknown>;
  };
}

export interface SlackDirectory {
  /** email → Slack user id */
  idByEmail: Map<string, string>;
  /** Slack user id → email */
  emailById: Map<string, string>;
  /** Slack user id → their 1:1 DM channel with the user */
  imByUser: Map<string, string>;
}

type Member = { id?: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string } };

/** Who is who in Slack, and which DM belongs to whom. Null when Slack cannot be read. */
export async function slackDirectory(web: SlackLike): Promise<SlackDirectory | null> {
  try {
    const idByEmail = new Map<string, string>();
    const emailById = new Map<string, string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = (await web.users.list({ limit: 200, cursor })) as { members?: Member[]; response_metadata?: { next_cursor?: string } };
      for (const m of r.members ?? []) {
        const e = lc(m.profile?.email);
        if (m.id && e && !m.deleted && !m.is_bot) { idByEmail.set(e, m.id); emailById.set(m.id, e); }
      }
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    const ims = (await web.conversations.list({ types: "im", limit: 200 })) as { channels?: Array<{ id?: string; user?: string }> };
    const imByUser = new Map<string, string>();
    for (const c of ims.channels ?? []) if (c.id && c.user) imByUser.set(c.user, c.id);
    return { idByEmail, emailById, imByUser };
  } catch (e) {
    console.warn("[followups] slack directory unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** What the user wrote in their DM with this person after `sinceIso`. */
export async function touchesFromSlackDm(
  web: SlackLike, selfId: string, dir: SlackDirectory | null, email: string | undefined, sinceIso: string,
): Promise<Touch[]> {
  const uid = dir?.idByEmail.get(lc(email));
  const channel = uid ? dir?.imByUser.get(uid) : undefined;
  if (!channel) return [];
  try {
    const oldest = String(Date.parse(sinceIso) / 1000);
    const r = (await web.conversations.history({ channel, oldest, limit: 20 })) as { messages?: Array<{ user?: string; text?: string; ts?: string; subtype?: string }> };
    return (r.messages ?? [])
      .filter((m) => m.user === selfId && !m.subtype && (m.text ?? "").trim() && m.ts)
      .slice(0, MAX_TOUCHES)
      .map((m) => ({ channel: "slack" as const, at: new Date(parseFloat(m.ts as string) * 1000).toISOString(), text: clip((m.text ?? "").replace(/\s+/g, " "), 240) }));
  } catch {
    return [];
  }
}

/** A short signature of the touches — a verdict is re-checked when it changes. Pure. */
export function touchSignature(touches: readonly Touch[]): string {
  if (touches.length === 0) return "0";
  const newest = touches.reduce((a, t) => (t.at > a ? t.at : a), "");
  return `${touches.length}:${newest}`;
}
