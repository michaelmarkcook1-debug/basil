import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";
import { deleteIntegrationToken } from "@/lib/storage/secure-token-store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";

// GET /api/auth/google — redirects to Google OAuth consent screen
export async function GET(req: Request) {
  const from = new URL(req.url).searchParams.get("from") ?? "";
  const url = getAuthUrl();
  const res = NextResponse.redirect(url);
  if (from) res.cookies.set("basil_auth_from", from, { path: "/", httpOnly: true, maxAge: 600 });
  return res;
}

// DELETE /api/auth/google — removes stored Google tokens for the current user
export async function DELETE() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  await deleteIntegrationToken(username, "google");
  // Flush immediately so the disconnected state survives any subsequent cold start.
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}
