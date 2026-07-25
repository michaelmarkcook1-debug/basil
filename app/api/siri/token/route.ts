/**
 * /api/siri/token — manage the per-user Siri Shortcuts bearer token.
 *
 * Session-authenticated (you must be logged into the web app):
 *   GET    → { active, createdAt, lastUsedAt }   (never the token itself)
 *   POST   → { token }  — create/regenerate; the raw token is shown ONCE
 *   DELETE → { ok }     — revoke
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  createSiriToken,
  revokeSiriToken,
  getSiriTokenStatus,
} from "@/lib/auth/siri-tokens";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(await getSiriTokenStatus(username));
}

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const token = await createSiriToken(username);
  console.info(`[api/siri/token] token generated for ${username}`);
  return NextResponse.json({ token });
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await revokeSiriToken(username);
  console.info(`[api/siri/token] token revoked for ${username}`);
  return NextResponse.json({ ok: true });
}
