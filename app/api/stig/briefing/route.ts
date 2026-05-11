import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { runStigBriefing } from "@/lib/stig/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handleRequest(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const result = await runStigBriefing(user.username, user.authMode);
    return NextResponse.json(result);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***");
    console.error("[stig/briefing] GET error:", msg);

    const isBrainMissing =
      msg.includes("OPENAI_API_KEY") ||
      msg.includes("openai_basilv2") ||
      msg.includes("not set");
    return NextResponse.json(
      {
        ok: false,
        error: isBrainMissing
          ? "AI brain not configured. Add openai_basilv2 or OPENAI_API_KEY."
          : msg,
        briefing: null,
        generatedAt: new Date().toISOString(),
        sources: [],
      },
      { status: isBrainMissing ? 503 : 500 }
    );
  }
}

export async function GET(req: Request) {
  return handleRequest(req);
}

export async function POST(req: Request) {
  return handleRequest(req);
}
