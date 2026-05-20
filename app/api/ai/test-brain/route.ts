import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getTextModel, PROVIDER_MODE } from "@/lib/ai/model-config";
import { generateText } from "ai";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const start = Date.now();
  try {
    const model = getTextModel("fast");
    const { text, usage } = await generateText({
      model,
      messages: [
        { role: "system", content: "You are a connectivity test. Reply with exactly one word." },
        { role: "user",   content: "Reply with the single word: ready" },
      ],
      maxOutputTokens: 16,
    });

    return NextResponse.json({
      ok: true,
      providerMode: PROVIDER_MODE,
      text: text.trim(),
      model: String(model),
      durationMs: Date.now() - start,
      usage,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      providerMode: PROVIDER_MODE,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
