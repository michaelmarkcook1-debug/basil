/**
 * GET    /api/auth/readai — start connecting Read AI (OAuth with PKCE, meeting:read only).
 * DELETE /api/auth/readai — disconnect (already-synced meetings stay in Basil).
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildOAuthState } from "@/lib/auth/oauth-state";
import { readAiAuthorizeUrl, deleteReadAiTokens } from "@/lib/readai/oauth";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.redirect(new URL("/login?return=/dashboard/settings", req.url));
  try {
    const st = buildOAuthState("readai");
    const { url, verifier } = await readAiAuthorizeUrl(username, st.state);
    console.log(`[readai/connect] starting OAuth for ${username}`);
    const res = NextResponse.redirect(url);
    res.cookies.set(st.name, st.value, st.options);
    res.cookies.set("basil_readai_pkce", verifier, { ...st.options });
    return res;
  } catch (e) {
    console.error("[readai/connect] could not start:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/dashboard/settings?error=readai_oauth_failed", req.url));
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await deleteReadAiTokens(username);
  console.log(`[readai/connect] disconnected for ${username}`);
  return NextResponse.json({ ok: true });
}
