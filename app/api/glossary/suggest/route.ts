/**
 * POST /api/glossary/suggest — { terms: string[] } → a likely meaning for each,
 * read from where the term appears in your own material. Suggestions only:
 * nothing is saved until you confirm it.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { gatherOwnTexts, contextsFor } from "@/lib/glossary/sources";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { parseAndValidate } from "@/lib/ai/parse-json";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import { redactSensitive } from "@/lib/security/sensitive";

export const maxDuration = 60;

const Suggestions = z.object({
  suggestions: z.array(z.object({
    term: z.string(),
    meaning: z.string().nullable(),
    kind: z.enum(["acronym", "project", "person", "term"]).optional().default("acronym"),
  })),
});

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const rl = await checkRateLimitDurable(`glossary:suggest:${username}`, 6);
  if (!rl.allowed) return NextResponse.json({ error: "Too many requests — try again shortly." }, { status: 429 });
  let terms: string[] = [];
  try {
    const b = await req.json() as { terms?: unknown };
    terms = Array.isArray(b.terms) ? b.terms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 12) : [];
  } catch { /* handled below */ }
  if (terms.length === 0) return NextResponse.json({ error: "terms are required" }, { status: 400 });

  const texts = await gatherOwnTexts(username);
  const evidence = terms.map((t) => `### ${t}\n${contextsFor(t, texts).map((c) => `- ${redactSensitive(c).text}`).join("\n") || "- (no context found)"}`).join("\n\n");
  try {
    const { text } = await generateTextSafe({
      model: getTextModel("fast"),
      maxOutputTokens: 800,
      system: "You decode workplace shorthand from the snippets you are given. Use only that evidence. If the snippets do not make a meaning clear, return null — a wrong expansion is worse than none.",
      prompt: `For each term, give its most likely meaning in this person's work, based only on the snippets.
Return JSON only: {"suggestions":[{"term":"","meaning":"short expansion and what it is, or null","kind":"acronym|project|person|term"}]}

${evidence}`,
    }, "fast", { username, feature: "glossary-suggest" });
    const parsed = parseAndValidate(text, Suggestions, "[glossary-suggest]");
    if (!parsed.ok) return NextResponse.json({ suggestions: [] });
    const asked = new Set(terms);
    return NextResponse.json({ suggestions: parsed.data.suggestions.filter((s) => asked.has(s.term) && s.meaning) });
  } catch (e) {
    if (e instanceof SpendCapError) return spendCapResponse(e);
    console.error("[glossary-suggest] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not suggest meanings." }, { status: 502 });
  }
}
