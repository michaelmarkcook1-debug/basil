/**
 * POST /api/admin/import-contacts?username=<user>
 *
 * Bulk-imports contacts into a user's PRIVATE contact store. Built so the owner
 * can restore contacts into production (Vercel Blob) without wrangling a browser
 * session — point it at the payload that scripts/restore-contacts-from-seed.mjs
 * emits (.data/restored-contacts.import.json, shape { import: Contact[] }).
 *
 * Protected by ADMIN_API_TOKEN — no session required.
 *
 * username: query param ?username=… OR body.username.
 * contacts: body.import (or body.contacts) — a Contact[].
 *
 * Returns { imported: number }. Idempotent: existing contacts (by id) aren't
 * duplicated by the underlying bulk import.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualStr } from "@/lib/auth/safe-compare";
import { bulkImportUserContacts } from "@/lib/contacts/user-store";
import type { Contact } from "@/lib/contacts-data";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "ADMIN_API_TOKEN is not configured." }, { status: 503 });
  }
  if (!timingSafeEqualStr(req.headers.get("x-admin-token"), token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const username =
    new URL(req.url).searchParams.get("username")?.trim() ||
    (typeof body.username === "string" ? body.username.trim() : "");
  const contacts = (Array.isArray(body.import) ? body.import : body.contacts) as Contact[] | undefined;

  if (!username) {
    return NextResponse.json({ error: "username is required (?username= or body.username)." }, { status: 400 });
  }
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json({ error: "body.import (or body.contacts) must be a non-empty Contact[]." }, { status: 400 });
  }

  const imported = await bulkImportUserContacts(username, contacts);
  return NextResponse.json({ ok: true, username, imported });
}
