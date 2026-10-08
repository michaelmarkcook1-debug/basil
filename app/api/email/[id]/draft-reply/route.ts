/**
 * POST /api/email/[id]/draft-reply — Basil suggests a reply; nothing is sent.
 * Body: { instruction?: string }  ("say yes but push to Thursday")
 */
import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { getReplyContext } from "@/lib/google/gmail";
import { getTaskSystemPrompt } from "@/lib/ai/system-prompt";
import { generateTextSafe } from "@/lib/ai/generate";
import { getTextModel } from "@/lib/ai/model-config";
import { SpendCapError, spendCapResponse } from "@/lib/ai/spend-guard";
import { getSettings } from "@/lib/settings/store";
import { checkRateLimitDurable } from "@/lib/rate-limit";
import { redactSensitive } from "@/lib/security/sensitive";

export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) return NextResponse.json({ error: "Gmail not connected." }, { status: 401 });
  const rl = await checkRateLimitDurable(`email:draft:${username}`, 15);
  if (!rl.allowed) return NextResponse.json({ error: "Too many drafts — try again shortly." }, { status: 429 });
  const { id } = await params;
  let instruction = "";
  try { const b = await req.json() as { instruction?: unknown }; instruction = typeof b.instruction === "string" ? b.instruction.slice(0, 500) : ""; } catch { /* no body is fine */ }

  try {
    const [ctx, settings] = await Promise.all([getReplyContext(username, id), getSettings(username)]);
    const first = settings.name.split(" ")[0] || settings.name;
    const system = await getTaskSystemPrompt(username, undefined, {
      memories: 8,
      focus: { text: `${ctx.from.name} ${ctx.subject}` },
      personasFor: ctx.from.name,
      maxPersonas: 1,
      glossaryFor: ctx.body.slice(0, 6_000),
    });
    const original = redactSensitive(ctx.body.slice(0, 6_000)).text;
    const { text } = await generateTextSafe({
      model: getTextModel("default"),
      maxOutputTokens: 700,
      system,
      prompt: `Draft ${first}'s reply to this email, in ${first}'s voice: direct, warm, brief.
Write only the reply body — greeting and sign-off included, no subject line, no quoted original.
Use only facts from the email${instruction ? " and the instruction" : ""}; do not commit ${first} to anything the instruction does not.
${instruction ? `\nInstruction from ${first}: ${instruction}\n` : ""}
From: ${ctx.from.name || ctx.from.email} <${ctx.from.email}>
Subject: ${ctx.subject}

${original}`,
    }, "default", { username, feature: "email-reply-draft" });
    return NextResponse.json({ body: text.trim() });
  } catch (e) {
    if (e instanceof SpendCapError) return spendCapResponse(e);
    console.error("[email/draft-reply] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Basil could not draft a reply." }, { status: 502 });
  }
}
