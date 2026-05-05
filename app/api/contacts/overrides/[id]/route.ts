import { NextResponse } from "next/server";
import {
  setOverrideInStore,
  clearOverrideFromStore,
} from "@/lib/contacts/overrides-store";
import type { ProfileOverride } from "@/lib/contact-profile-overrides";
import { getSessionUser } from "@/lib/auth";

/**
 * PUT /api/contacts/overrides/:id
 * Body: ProfileOverride  → merges patch into stored override for this contact.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    const patch = (await req.json()) as ProfileOverride;
    const merged = await setOverrideInStore(username, id, patch);
    return NextResponse.json({ override: merged });
  } catch (e) {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/contacts/overrides/:id
 * Clears the AI-generated override for this contact (falls back to seed data).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    await clearOverrideFromStore(username, id);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
