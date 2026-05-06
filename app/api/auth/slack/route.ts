import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveSlackConfig, deleteSlackConfig } from "@/lib/slack/client";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

/**
 * POST /api/auth/slack
 *
 * Saves per-user Slack bot/user tokens to the user's scoped store.
 * Body: { botToken?: string; userToken?: string }
 *
 * DELETE /api/auth/slack
 *
 * Removes the stored Slack config for the current user.
 */

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: { botToken?: string; userToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const botToken  = (body.botToken  ?? "").trim() || undefined;
  const userToken = (body.userToken ?? "").trim() || undefined;

  if (!botToken && !userToken) {
    return NextResponse.json({ error: "At least one token is required" }, { status: 400 });
  }

  await saveSlackConfig(username, { botToken, userToken });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  await deleteSlackConfig(username);
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
