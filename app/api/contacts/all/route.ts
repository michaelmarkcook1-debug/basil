import { NextResponse } from "next/server";
import { contacts as seedContacts } from "@/lib/contacts-data";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/contacts/all
 *
 * Returns the complete contacts list: seed contacts (from contacts-data.ts)
 * merged with user-added contacts (from the server store), deduplicated by id.
 * Used by the mobile app so it sees the same list as the web dashboard.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const userContacts = await listUserContacts();

  // Deduplicate: user contacts win over seed contacts with the same id
  const userIds = new Set(userContacts.map((c) => c.id));
  const merged = [
    ...seedContacts.filter((c) => !userIds.has(c.id)),
    ...userContacts,
  ];

  return NextResponse.json({ contacts: merged });
}
