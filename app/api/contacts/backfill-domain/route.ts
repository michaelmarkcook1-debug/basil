import { NextResponse } from "next/server";
import {
  listUserContacts,
  updateUserContactInStore,
} from "@/lib/contacts/user-store";
import { getSessionUser } from "@/lib/auth";

/**
 * POST /api/contacts/backfill-domain
 *
 * One-shot backfill:
 *  - Scans all user contacts that have an email address.
 *  - For every contact whose email ends with @talentgenius.io:
 *      type      → "internal"
 *      company   → "TalentGenius"
 *      directory → "work"
 *
 * Idempotent — re-running skips contacts already correctly tagged.
 */
export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const all = await listUserContacts(username);

  const toUpdate = all.filter(
    (c) =>
      c.email &&
      c.email.toLowerCase().endsWith("@talentgenius.io") &&
      (c.type !== "internal" ||
        c.company !== "TalentGenius" ||
        c.directory !== "work")
  );

  const results: { id: string; name: string; email: string }[] = [];

  for (const c of toUpdate) {
    await updateUserContactInStore(username, c.id, {
      type: "internal",
      company: "TalentGenius",
      directory: "work",
    });
    results.push({ id: c.id, name: c.name, email: c.email! });
  }

  return NextResponse.json({
    scanned: all.filter((c) => !!c.email).length,
    updated: results.length,
    contacts: results,
  });
}
