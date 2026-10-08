/** GET /api/glossary/unknown — shorthand that recurs in your own material but has no meaning yet. */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getGlossary } from "@/lib/glossary/store";
import { gatherOwnTexts } from "@/lib/glossary/sources";
import { findUnknownShorthand } from "@/lib/glossary/match";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const [g, texts] = await Promise.all([getGlossary(username), gatherOwnTexts(username)]);
  return NextResponse.json({ unknown: findUnknownShorthand(texts, g.entries, g.dismissed) });
}
