import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { testOpenAIConnection } from "@/lib/ai/openai";
import { PROVIDER_MODE } from "@/lib/ai/model-config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const result = await testOpenAIConnection();

  return NextResponse.json({
    providerMode: PROVIDER_MODE,
    openaiKeyPresent: !!process.env.openai_basilv2,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o (default)",
    ...result,
  });
}
