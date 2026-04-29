import { NextResponse } from "next/server";
import {
  listUserContacts,
  addUserContactToStore,
  bulkImportUserContacts,
} from "@/lib/contacts/user-store";
import type { Contact } from "@/lib/contacts-data";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/contacts/user
 * Returns all user-added contacts (excludes seed contacts from contacts-data.ts).
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const contacts = await listUserContacts();
  return NextResponse.json({ contacts });
}

/**
 * POST /api/contacts/user
 * Body: Contact  → adds a single contact
 * Body: { import: Contact[] } → bulk-imports (used for one-time localStorage migration)
 */
export async function POST(req: Request) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const body = await req.json();

    // Bulk migration path
    if (Array.isArray(body?.import)) {
      const added = await bulkImportUserContacts(body.import as Contact[]);
      return NextResponse.json({ imported: added }, { status: 201 });
    }

    const contact = body as Contact;
    if (!contact?.id || !contact?.name) {
      return NextResponse.json(
        { error: "contact must have id and name" },
        { status: 400 }
      );
    }
    const saved = await addUserContactToStore(contact);
    return NextResponse.json({ contact: saved }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
