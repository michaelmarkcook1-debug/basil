/**
 * POST /api/auth/linear  — save Linear Personal API Key
 * DELETE /api/auth/linear — remove Linear credentials
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveLinearConfig, validateApiKey } from "@/lib/linear/client";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

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
    return NextResponse.json(
      { error: `Invalid API key: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 400 }
    );
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  await saveLinearConfig(username, {});
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
