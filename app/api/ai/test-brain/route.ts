import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { PROVIDER_MODE, getChatModel } from "@/lib/ai/model-config";
import { generateTextSafe } from "@/lib/ai/generate";

export const dynamic = "force-dynamic";
// 45s so the fast-tier fallback chain (≤12s primary + ≤12s cross-provider
// fallback) always completes inside the function budget, with headroom for a
// cold start. The old 30s could 504 if the primary attempt ran slow.
export const maxDuration = 45;

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const start = Date.now();
  try {
    // Intentionally UNMETERED: this is a ~16-output-token connectivity probe
    // that must succeed even when a user is over their AI spend cap. Uses
    // generateTextSafe so the Anthropic direct → OpenAI fallback chain applies
    // if the primary (gateway) is unavailable or has no credits.
    const result = await generateTextSafe({
      // Probe the ASSISTANT's model (getChatModel), not getTextModel("fast").
      // The chat page renders this response's `model` as "AI ready · <model>",
      // so probing the cheap fast tier made Ask Basil permanently advertise
      // itself as "claude-haiku-4-5" — a label for a 16-token connectivity
      // probe, not the model actually answering the user. The tier below stays
      // "fast" purely for its short timeout/reservation; it no longer picks the
      // model, because `model` is now supplied explicitly.
      model: getChatModel(),
      messages: [
        { role: "system", content: "You are a connectivity test. Reply with exactly one word." },
        { role: "user",   content: "Reply with the single word: ready" },
      ],
      maxOutputTokens: 16,
    }, "fast");
    const { text, usage } = result;
    // response.modelId reflects the model that actually responded (may differ
    // from the primary if generateTextSafe fell back to Anthropic/OpenAI direct).
    const modelLabel = (result.response as { modelId?: string } | undefined)?.modelId ?? PROVIDER_MODE;

    return NextResponse.json({
      ok: true,
      providerMode: PROVIDER_MODE,
      text: text.trim(),
      model: modelLabel,
      durationMs: Date.now() - start,
      usage,
    });
  } catch (e) {
    // Build a useful error string — SDK errors sometimes have empty .message
    // but carry detail in .cause or other properties.
    let errorMsg = "";
    if (e instanceof Error) {
      errorMsg = e.message;
      if (!errorMsg && e.cause) errorMsg = String(e.cause);
      if (!errorMsg) {
        // Stringify the whole error object for any remaining properties
        try { errorMsg = JSON.stringify(e, Object.getOwnPropertyNames(e)); } catch { /* ignore */ }
      }
    } else {
      errorMsg = String(e);
    }

    return NextResponse.json({
      ok: false,
      providerMode: PROVIDER_MODE,
      durationMs: Date.now() - start,
      error: errorMsg || "unknown error (no message)",
    });
  }
}
