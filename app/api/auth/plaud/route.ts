/**
 * GET    /api/auth/plaud — start connecting Plaud (OAuth with PKCE, via Plaud's MCP server).
 * DELETE /api/auth/plaud — disconnect (Basil forgets the tokens; already-synced recordings stay).
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildOAuthState } from "@/lib/auth/oauth-state";
import { plaudAuthorizeUrl, deletePlaudTokens } from "@/lib/plaud/oauth";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.redirect(new URL("/login?return=/dashboard/settings", req.url));
  try {
    const st = buildOAuthState("plaud");
    const { url, verifier } = await plaudAuthorizeUrl(username, st.state);
    console.log(`[plaud/connect] starting OAuth for ${username}`);
    const res = NextResponse.redirect(url);
    res.cookies.set(st.name, st.value, st.options);
    res.cookies.set("basil_plaud_pkce", verifier, { ...st.options });
    return res;
  } catch (e) {
    console.error("[plaud/connect] could not start:", e instanceof Error ? e.message : e);
    return NextResponse.redirect(new URL("/dashboard/settings?error=plaud_oauth_failed", req.url));
  }
}

export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await deletePlaudTokens(username);
  console.log(`[plaud/connect] disconnected for ${username}`);
  return NextResponse.json({ ok: true });
}
