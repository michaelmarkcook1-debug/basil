import { NextResponse } from "next/server";
import {
  updateUserContactInStore,
  deleteUserContactFromStore,
} from "@/lib/contacts/user-store";
import type { Contact } from "@/lib/contacts-data";

/**
 * PATCH /api/contacts/user/:id
 * Body: Partial<Contact>  → merges patch into existing record.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const patch = (await req.json()) as Partial<Contact>;
    const updated = await updateUserContactInStore(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return NextResponse.json({ contact: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
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
    const { id } = await params;
    const deleted = await deleteUserContactFromStore(id);
    if (!deleted) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
