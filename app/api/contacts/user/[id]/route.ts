import { NextResponse } from "next/server";
import {
  updateUserContactInStore,
  deleteUserContactFromStore,
} from "@/lib/contacts/user-store";
import type { Contact } from "@/lib/contacts-data";
import { getSessionUser } from "@/lib/auth";

/**
 * PATCH /api/contacts/user/:id
 * Body: Partial<Contact>  → merges patch into existing record.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    const patch = (await req.json()) as Partial<Contact>;
    const updated = await updateUserContactInStore(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return NextResponse.json({ contact: updated });
  } catch (e) {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/contacts/user/:id
 * Removes the contact from the server store.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    const deleted = await deleteUserContactFromStore(id);
    if (!deleted) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
