import { NextResponse } from "next/server";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/contacts/overrides
 * Returns the full map of AI-generated profile overrides keyed by contactId.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const overrides = await getAllOverridesFromStore(username);
  return NextResponse.json({ overrides });
}
