import { NextResponse } from "next/server";
import {
  setOverrideInStore,
  clearOverrideFromStore,
} from "@/lib/contacts/overrides-store";
import type { ProfileOverride } from "@/lib/contact-profile-overrides";

/**
 * PUT /api/contacts/overrides/:id
 * Body: ProfileOverride  → merges patch into stored override for this contact.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const patch = (await req.json()) as ProfileOverride;
    const merged = await setOverrideInStore(id, patch);
    return NextResponse.json({ override: merged });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
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
    const { id } = await params;
    await clearOverrideFromStore(id);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
