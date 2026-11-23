/**
 * lib/email/needs-reply.ts — does this email actually want something from you?
 *
 * The awaiting-reply detector is mechanical: addressed to you, from a person,
 * still the last word in its thread. That is necessary but nowhere near
 * sufficient. Observed on Today 2026-10-10, all three "Reply to …" cards needed
 * nothing: "I'll take a look" (the ball is in their court), "will keep you
 * posted" (an update), and a Microsoft Bookings confirmation. A nag list that is
 * wrong is a nag list you stop reading.
 *
 * One cheap model call per batch of NEW emails; every verdict is stored by
 * message id so an email is judged once. Fails OPEN: if the judge is down or
 * unsure, the card stays — hiding a real request is the expensive mistake.
 */
import "server-only";
import { z } from "zod";
import { readUserStore, updateUserStore } from "@/lib/storage/user-store";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";

const FILE = "email-reply-judgments.json";
const MAX_STORED = 400;
const BATCH = 6;
/**
 * v2 (2026-11-23): the judge reads the whole latest message, who it is addressed
 * to, the earlier thread and what the user has done with the sender since.
 * v1 verdicts were made from a ~140-character preview under the premise "this is
 * addressed to you" — "Anja, do you have time next week?" from Guy, with Michael
 * only copied, was stored as "asks if Michael has time". v1 verdicts are re-judged.
 */
const VERSION = 2;

/** Something the user did with the sender after the message (see lib/followups/context). */
export interface ReplyTouch { channel: "email" | "slack" | "meeting"; at: string; text: string }

export interface ReplyCandidate {
  /** Gmail message id, or "slack:<channel>" for a Slack DM. */
  id: string;
  from: string;
  subject: string;
  /** The latest message in full (quoted history removed), or its opening when that is all there is. */
  text: string;
  channel?: "email" | "slack";
  /** When it was sent. */
  at?: string;
  to?: string;
  cc?: string;
  /** The conversation before it, oldest first. */
  earlier?: Array<{ from: string; at: string; text: string }>;
  /** What the user has done with the sender since — any thread, Slack, meetings. */
  since?: ReplyTouch[];
  /** Changes when `since` changes, so a "still waiting" verdict is checked again. */
  sinceSig?: string;
}

export interface ReplyVerdict { needsReply: boolean; reason: string }
type Stored = ReplyVerdict & { at: string; v?: number; sig?: string };

export interface ReplyJudgeOptions {
  /** The user's own addresses, so the judge can read the To and Cc lines. */
  selfEmails?: string[];
}

/** Judge a batch. Returns a verdict per id it is confident about; omitted ids stay. */
export type ReplyJudge = (firstName: string, batch: ReplyCandidate[], opts?: ReplyJudgeOptions) => Promise<Map<string, ReplyVerdict>>;

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);
const day = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "?");

function describe(c: ReplyCandidate, firstName: string): string {
  const head = [
    `[${c.id}] ${c.channel === "slack" ? "Slack DM" : "Email"} from ${c.from}${c.at ? ` on ${day(c.at)}` : ""}`,
    c.to ? `To: ${clip(c.to, 300)}` : "",
    c.cc ? `Cc: ${clip(c.cc, 300)}` : "",
    c.subject ? `Subject: ${clip(c.subject, 140)}` : "",
  ].filter(Boolean).join("\n");
  const earlier = (c.earlier ?? []).slice(-3).map((m) => `  - ${m.from} (${day(m.at)}): ${clip(m.text.replace(/\s+/g, " "), 280)}`).join("\n");
  const since = (c.since ?? []).map((t) => `  - ${t.channel} (${day(t.at)}): ${clip(t.text, 240)}`).join("\n");
  return [
    head,
    earlier ? `Earlier in the conversation:\n${earlier}` : "",
    `Message:\n${clip(c.text, 2500)}`,
    `Since then, ${firstName} has: ${since ? `\n${since}` : "nothing recorded"}`,
  ].filter(Boolean).join("\n");
}

/** Exported for tests. */
export function needsReplyPrompt(firstName: string, batch: ReplyCandidate[], opts: ReplyJudgeOptions = {}): string {
  const mine = (opts.selfEmails ?? []).filter(Boolean);
  return `${firstName} wants a list of messages that are still waiting on ${firstName} personally. Read each message in full and decide needsReply.
${mine.length ? `${firstName}'s own addresses: ${mine.join(", ")}.\n` : ""}
needsReply = true only when BOTH hold:
1. The message asks ${firstName} personally for something — a question, a decision, approval, information, a document, a time to meet — or chases ${firstName} for one. Check who is being asked: the greeting ("Anja, …", "Hi team", "Hi ${firstName}") and the To line. A message to someone else that ${firstName} is copied on, or a colleague keeping ${firstName} in the loop, does not need ${firstName}.
2. Nothing under "Since then" shows ${firstName} has already dealt with it: a reply by email in any thread, a Slack message to the person, or a meeting with them that covers the ask. A routine repeating meeting counts only when the ask is something to take up there.

needsReply = false when the message:
- is addressed to, or asks, someone other than ${firstName}
- only acknowledges or thanks ("I'll take a look", "got it", "sounds good")
- says the sender will act or report back ("will keep you posted")
- is an FYI, update or announcement that asks nothing of ${firstName}
- is an automatic notification (meeting booked, invite, receipt, signature completed, alert), a newsletter or a mass mailing
- has already been dealt with since, as above

If it clearly asks ${firstName} and you cannot tell whether ${firstName} has dealt with it, answer true.

Messages:

${batch.map((c) => describe(c, firstName)).join("\n\n---\n\n")}

Respond with JSON only: [{"id": "...", "needsReply": true or false, "reason": "a few words"}]`;
}

const VerdictListSchema = z.array(z.object({
  id: z.string(),
  needsReply: z.boolean(),
  reason: z.string().optional().default(""),
}));

export function makeModelReplyJudge(username: string): ReplyJudge {
  return async (firstName, batch, opts) => {
    const out = new Map<string, ReplyVerdict>();
    try {
      const { text } = await generateTextSafe({
        model: getTextModel("fast"),
        // Room for a reasoning fallback model to think before it answers.
        maxOutputTokens: 1_200 + batch.length * 80,
        system: "You decide which messages still need the user to respond. Read every message in full before deciding.",
        prompt: needsReplyPrompt(firstName, batch, opts),
      }, "fast", { username, feature: "followups:needs-reply" });
      const parsed = parseAndValidate(text, VerdictListSchema, "[needs-reply]");
      if (!parsed.ok) return out;
      const asked = new Set(batch.map((c) => c.id));
      for (const v of parsed.data) if (asked.has(v.id)) out.set(v.id, { needsReply: v.needsReply, reason: v.reason });
    } catch (err) {
      console.warn("[needs-reply] judge failed, keeping every card:", err instanceof Error ? err.message : err);
    }
    return out;
  };
}

/**
 * Which candidates do NOT need a reply. Stored verdicts are reused; only new
 * emails reach the judge. Ids missing from the result need a reply (fail open).
 */
export async function filterNoReplyNeeded(
  username: string,
  firstName: string,
  candidates: ReplyCandidate[],
  judge: ReplyJudge = makeModelReplyJudge(username),
  opts: ReplyJudgeOptions = {},
): Promise<Map<string, ReplyVerdict>> {
  const stored = await readUserStore<Record<string, Stored>>(username, FILE, {});
  const verdicts = new Map<string, ReplyVerdict>();
  const fresh: ReplyCandidate[] = [];
  for (const c of candidates) {
    const s = stored[c.id];
    // Reuse a current verdict: "no reply needed" stands; "still waiting" stands
    // only while nothing new has happened with the sender since it was made.
    const current = s && s.v === VERSION && (!s.needsReply || (s.sig ?? "0") === (c.sinceSig ?? "0"));
    if (current && s) verdicts.set(c.id, { needsReply: s.needsReply, reason: s.reason }); else fresh.push(c);
  }

  const learned: Record<string, Stored> = {};
  const sigOf = new Map(fresh.map((c) => [c.id, c.sinceSig ?? "0"]));
  for (let i = 0; i < fresh.length; i += BATCH) {
    const got = await judge(firstName, fresh.slice(i, i + BATCH), opts);
    for (const [id, v] of got) {
      verdicts.set(id, v);
      learned[id] = { ...v, at: new Date().toISOString(), v: VERSION, sig: sigOf.get(id) ?? "0" };
    }
  }
  if (Object.keys(learned).length) {
    await updateUserStore<Record<string, Stored>>(username, FILE, (cur) => {
      const all = Object.entries({ ...cur, ...learned }).sort((a, b) => b[1].at.localeCompare(a[1].at));
      return Object.fromEntries(all.slice(0, MAX_STORED));
    }, {}, { allowShrink: true }).catch((e) =>
      console.warn("[needs-reply] could not store verdicts:", e instanceof Error ? e.message : e));
  }

  return new Map([...verdicts].filter(([, v]) => !v.needsReply));
}
