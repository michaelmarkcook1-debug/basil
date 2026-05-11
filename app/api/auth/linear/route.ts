/**
 * POST /api/auth/linear  — save Linear Personal API Key
 * DELETE /api/auth/linear — remove Linear credentials
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveLinearConfig, deleteLinearConfig, validateApiKey } from "@/lib/linear/client";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
function safeLinearError(err: unknown): { message: string; status: number } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("BASIL_TOKEN_ENCRYPTION_KEY")) {
    return {
      message: "BASIL_TOKEN_ENCRYPTION_KEY is missing or invalid. Set it before saving integration tokens.",
      status: 500,
    };
  }
  return { message: msg, status: 400 };
}


export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const apiKey = (body.apiKey ?? "").trim();
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  // Validate the key before saving
  try {
    const name = await validateApiKey(apiKey);
    await saveLinearConfig(username, { apiKey });
    await forceFlushSnapshot();
    return NextResponse.json({ ok: true, name });
  } catch (err) {
    const { message, status } = safeLinearError(err);
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  await deleteLinearConfig(username);
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
