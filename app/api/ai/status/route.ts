/**
 * GET /api/ai/status — is the assistant configured, and with what?
 *
 * Answered from configuration alone. Never calls a model. The chat page used
 * to hit /api/ai/test-brain on every mount — a real, unmetered generation
 * just to render "AI ready · <model>" — so opening a screen cost AI spend.
 * test-brain remains for an explicit connectivity check.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { PROVIDER_MODE, getChatModel } from "@/lib/ai/model-config";
import { claudeCreditOut } from "@/lib/ai/provider-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let model: string | null = null;
  let ok = false;
  try {
    const m = getChatModel();
    model = typeof m === "string" ? m : m.modelId ?? null;
    ok = !!model;
  } catch (e) {
    return NextResponse.json({ ok: false, providerMode: PROVIDER_MODE, model: null, error: e instanceof Error ? e.message : "not configured" });
  }
  // Claude refused for billing in the last 30 minutes: the home says so, since
  // Basil no longer falls back to another model (lib/ai/provider-health).
  return NextResponse.json({ ok, providerMode: PROVIDER_MODE, model, probe: "configuration", claudeCreditOut: await claudeCreditOut() });
}
