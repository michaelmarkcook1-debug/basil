import { NextResponse } from "next/server";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";

/**
 * GET /api/contacts/overrides
 * Returns the full map of AI-generated profile overrides keyed by contactId.
 */
export async function GET() {
  const overrides = await getAllOverridesFromStore();
  return NextResponse.json({ overrides });
}
