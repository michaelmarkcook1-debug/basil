import { NextResponse } from "next/server";
import { sampleContacts } from "@/lib/contacts-data";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/contacts/all
 *
 * Returns the user's contacts (from the server store). Sample contacts are off
 * by default (sampleContacts() returns [] unless a demo flag is set), so the
 * mobile app sees the same real-only list as the web dashboard — never the
 * fictional "(SAMPLE)" fixtures.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const userContacts = await listUserContacts(username);

  // Deduplicate: user contacts win over any sample contact with the same id
  const userIds = new Set(userContacts.map((c) => c.id));
  const merged = [
    ...sampleContacts().filter((c) => !userIds.has(c.id)),
    ...userContacts,
  ];

  return NextResponse.json({ contacts: merged });
}
