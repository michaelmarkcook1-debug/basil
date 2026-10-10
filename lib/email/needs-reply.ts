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
const BATCH = 12;

export interface ReplyCandidate {
  /** Gmail message id. */
  id: string;
  from: string;
  subject: string;
  /** Snippet / opening of the latest message. */
  text: string;
}

export interface ReplyVerdict { needsReply: boolean; reason: string }
type Stored = ReplyVerdict & { at: string };

/** Judge a batch. Returns a verdict per id it is confident about; omitted ids stay. */
export type ReplyJudge = (firstName: string, batch: ReplyCandidate[]) => Promise<Map<string, ReplyVerdict>>;

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Exported for tests. */
export function needsReplyPrompt(firstName: string, batch: ReplyCandidate[]): string {
  return `${firstName} is triaging email. For each message below (the latest message in its conversation, addressed to ${firstName}), decide whether ${firstName} needs to REPLY.

needsReply = false when the message:
- only acknowledges or confirms ("I'll take a look", "thanks", "got it", "will do", "sounds good")
- says the sender will act or report back ("will keep you posted", "I'll get back to you")
- is an FYI, status update or announcement that asks nothing of ${firstName}
- is an automatic confirmation or notification (meeting booked/scheduled, calendar invite, receipt, signature or agreement completed, system alert)
- is a newsletter, marketing or a mass mailing

needsReply = true when it asks ${firstName} a question, asks for a decision, approval, information or a document, proposes something that needs an answer, or chases a reply. If unsure, answer true.

Messages:
${batch.map((c) => `[${c.id}] From: ${c.from} | Subject: ${clip(c.subject, 140)}\n${clip(c.text)}`).join("\n\n")}

Respond with JSON only: [{"id": "...", "needsReply": true or false, "reason": "a few words"}]`;
}

const VerdictListSchema = z.array(z.object({
  id: z.string(),
  needsReply: z.boolean(),
  reason: z.string().optional().default(""),
}));

export function makeModelReplyJudge(username: string): ReplyJudge {
  return async (firstName, batch) => {
    const out = new Map<string, ReplyVerdict>();
    try {
      const { text } = await generateTextSafe({
        model: getTextModel("fast"),
        maxOutputTokens: 60 + batch.length * 60,
        system: "You decide whether emails need a reply. Be conservative: when in doubt, they do.",
        prompt: needsReplyPrompt(firstName, batch),
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
): Promise<Map<string, ReplyVerdict>> {
  const stored = await readUserStore<Record<string, Stored>>(username, FILE, {});
  const verdicts = new Map<string, ReplyVerdict>();
  const fresh: ReplyCandidate[] = [];
  for (const c of candidates) {
    const s = stored[c.id];
    if (s) verdicts.set(c.id, s); else fresh.push(c);
  }

  const learned: Record<string, Stored> = {};
  for (let i = 0; i < fresh.length; i += BATCH) {
    const got = await judge(firstName, fresh.slice(i, i + BATCH));
    for (const [id, v] of got) { verdicts.set(id, v); learned[id] = { ...v, at: new Date().toISOString() }; }
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
