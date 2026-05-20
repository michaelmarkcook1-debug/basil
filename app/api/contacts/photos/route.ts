import { NextResponse } from "next/server";
import crypto from "crypto";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/contacts/photos?emails=a@x.com,b@y.com
 *
 * Returns a Gravatar URL for each requested email address. Gravatar uses the MD5
 * hash of the lowercased email and returns 404 when the account has no avatar —
 * the AvatarImage component handles this gracefully by falling through to the
 * AvatarFallback (initials) at the UI layer.
 *
 * Requires authentication. Capped at 100 emails per call.
 */
export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const emailsParam = searchParams.get("emails") ?? "";
  const emails = emailsParam
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 100);

  const photos: Record<string, string> = {};
  for (const email of emails) {
    const hash = crypto.createHash("md5").update(email).digest("hex");
    photos[email] = `https://www.gravatar.com/avatar/${hash}?s=200&d=404`;
  }

  return NextResponse.json({ photos }, {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
