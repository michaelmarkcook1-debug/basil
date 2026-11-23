/**
 * Read one conversation and decide what Basil keeps from it.
 *
 * The user chose "work only" (2026-11-10): a conversation about work, people,
 * companies or projects is summarised and kept; anything personal (health,
 * family, money, relationships, private interests) is recorded only as "seen"
 * so it is not read again, with no title, words or summary stored.
 */
import "server-only";
import { z } from "zod";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel, MAX_TOKENS } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { DATA_NOT_INSTRUCTIONS } from "@/lib/ai/injection-guard";
import { readingText, type ChatTranscript } from "./parse";

export const ChatDigestSchema = z.object({
  work: z.boolean(),
  summary: z.string().default(""),
  topics: z.array(z.string()).default([]),
  people: z.array(z.string()).default([]),
  companies: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  openItems: z.array(z.string()).default([]),
});
export type ChatDigest = z.infer<typeof ChatDigestSchema>;

const SYSTEM = `You sort a person's conversations with an AI assistant for their executive assistant, Basil.

Decide whether the conversation is WORK: their job, company, colleagues, clients, prospects, products, projects, strategy, writing done for work, industry research, or professional development.
Anything else is PERSONAL: health, medical, family, relationships, money and personal finance, legal matters of their own, home, hobbies, travel for leisure, shopping, private interests. When a conversation mixes both, it is WORK only if work is its main subject. When unsure, it is PERSONAL.

For PERSONAL, return {"work": false} and nothing else — do not summarise it.

For WORK, return:
- summary: one or two sentences on what they were working out and where they got to, in the third person ("Michael drafted…").
- topics: up to 6 short topic labels.
- people: names of real people mentioned (not the AI).
- companies: organisations mentioned.
- decisions: conclusions they reached, if any.
- openItems: things they said they still need to do or decide.
Use only what the conversation says. Respond with JSON only.`;
// Conversations often contain pasted emails and documents written by others.
const SYSTEM_GUARDED = `${SYSTEM}\n\n${DATA_NOT_INSTRUCTIONS}`;

/** Null when the model call or its JSON failed — the caller retries next sync. */
export async function digestConversation(username: string, t: ChatTranscript): Promise<ChatDigest | null> {
  const { text } = await generateTextSafe({
    // Categorisation tier: deciding what a thing IS, plus a short summary.
    model: getTextModel("balanced"),
    // Room for a reasoning fallback model's thinking as well as the ~300-token
    // answer: at 1,200 most digests came back cut off mid-summary (2026-11-23).
    // Billing reconciles to tokens actually used, so the ceiling costs nothing.
    maxOutputTokens: Math.min(MAX_TOKENS.balanced, 6_000),
    system: SYSTEM_GUARDED,
    prompt: `Platform: ${t.platform === "chatgpt" ? "ChatGPT" : "Claude"}\nLast active: ${t.updatedAt.slice(0, 10)}\n\n${readingText(t)}`,
  }, "balanced", { username, feature: "ai-chats:digest" });
  const parsed = parseAndValidate(text, ChatDigestSchema, "[ai-chats]");
  if (!parsed.ok) return null;
  const d = parsed.data;
  if (!d.work) return { work: false, summary: "", topics: [], people: [], companies: [], decisions: [], openItems: [] };
  const trim = (xs: string[], n: number) => xs.map((x) => x.trim()).filter(Boolean).slice(0, n).map((x) => x.slice(0, 160));
  return {
    work: true,
    summary: d.summary.trim().slice(0, 600),
    topics: trim(d.topics, 6),
    people: trim(d.people, 12),
    companies: trim(d.companies, 12),
    decisions: trim(d.decisions, 6),
    openItems: trim(d.openItems, 6),
  };
}
