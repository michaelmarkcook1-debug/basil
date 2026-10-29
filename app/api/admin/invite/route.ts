/**
 * POST /api/admin/invite — admin only. Body: { name, surname?, email }.
 * Creates the account and returns a one-time "choose your password" link
 * (also emailed when email is configured). Returning the link is safe for the
 * same reason as /api/admin/reset-link: only a signed-in admin can call this,
 * and the admin is the one handing it to the colleague.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { findByUsername, isAdminUser } from "@/lib/users";
import { inviteUser } from "@/lib/auth/invite";

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  surname: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(320),
});

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username || !isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null)); // ci-ok: unreadable body → schema rejects null → 400 below
  if (!parsed.success) return NextResponse.json({ error: "Give a first name and a valid email." }, { status: 400 });
  const me = await findByUsername(username);
  const inviter = [me?.name, me?.surname].filter(Boolean).join(" ") || "Your colleague";
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${req.headers.get("host")}`;
  try {
    const result = await inviteUser({ ...parsed.data, inviter, baseUrl });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not create the account.";
    console.warn("[admin/invite] failed:", msg);
    return NextResponse.json({ error: msg }, { status: /already has/.test(msg) ? 409 : 500 });
  }
}
