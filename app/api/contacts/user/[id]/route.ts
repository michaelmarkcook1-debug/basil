import { NextResponse } from "next/server";
import {
  updateUserContactInStore,
  deleteUserContactFromStore,
} from "@/lib/contacts/user-store";
import type { Contact } from "@/lib/contacts-data";
import { getSessionUser } from "@/lib/auth";
import { deleteGenerateCache } from "@/lib/generate-cache/store";

/**
 * Drop the People page's cached activity roll-up.
 *
 * /api/contacts/activity caches its cross-source fan-out for 30 minutes. Without
 * this, mutating a contact leaves the page serving the OLD list — a deleted
 * contact keeps appearing, and an edited one keeps its old name — which reads as
 * "the delete didn't work". Best-effort: a failed invalidation must never fail
 * the user's edit; the cache expires on its own regardless.
 */
async function invalidateActivityCache(username: string) {
  await deleteGenerateCache(username, "contact-activity").catch((e) =>
    console.warn("[contacts] activity cache invalidation failed:", e instanceof Error ? e.message : e)
  );
}

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
    const updated = await updateUserContactInStore(username, id, patch);
    if (!updated) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    await invalidateActivityCache(username);
    return NextResponse.json({ contact: updated });
  } catch {
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
    const deleted = await deleteUserContactFromStore(username, id);
    if (!deleted) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    await invalidateActivityCache(username);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
