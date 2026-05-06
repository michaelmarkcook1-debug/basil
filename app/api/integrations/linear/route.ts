/**
 * /api/integrations/linear — Linear API key lifecycle.
 *
 * POST  { apiKey }  — validate and save the API key for the session user.
 * DELETE            — remove the API key (disconnect Linear).
 *
 * Read-only data fetching stays at /api/linear (used by the signals feed).
 */
import { NextResponse } from "next/server";
import { verifySession, getSessionUser } from "@/lib/auth";
import { saveLinearConfig, deleteLinearConfig, validateApiKey } from "@/lib/linear/client";

export async function POST(req: Request) {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey } = body;
  if (!apiKey?.trim()) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  // Validate the key against Linear's API before saving.
  try {
    const displayName = await validateApiKey(apiKey.trim());
    await saveLinearConfig(username, { apiKey: apiKey.trim() });
    console.log(`[linear/connect] ${username} connected Linear (${displayName})`);
    return NextResponse.json({ ok: true, displayName });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid API key";
    console.warn(`[linear/connect] ${username} key validation failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE() {
  if (!(await verifySession())) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  await deleteLinearConfig(username);
  console.log(`[linear/disconnect] ${username} disconnected Linear`);
  return NextResponse.json({ ok: true });
}
