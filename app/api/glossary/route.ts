/**
 * GET    /api/glossary          → { entries, dismissed }
 * POST   /api/glossary          → { term, meaning, kind?, aliases? } saves a term
 *                                  { dismiss: "TERM" } stops suggesting it
 * DELETE /api/glossary?id=…     → removes a term
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getGlossary, upsertTerm, removeTerm, dismissTerm } from "@/lib/glossary/store";
import type { GlossaryKind } from "@/lib/glossary/match";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(await getGlossary(username));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  let body: { term?: unknown; meaning?: unknown; kind?: unknown; aliases?: unknown; dismiss?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (typeof body.dismiss === "string") {
    await dismissTerm(username, body.dismiss);
    return NextResponse.json({ ok: true });
  }
  if (typeof body.term !== "string" || typeof body.meaning !== "string") {
    return NextResponse.json({ error: "term and meaning are required" }, { status: 400 });
  }
  try {
    const entry = await upsertTerm(username, {
      term: body.term,
      meaning: body.meaning,
      kind: typeof body.kind === "string" ? body.kind as GlossaryKind : undefined,
      aliases: Array.isArray(body.aliases) ? body.aliases.filter((a): a is string => typeof a === "string") : undefined,
    });
    return NextResponse.json({ entry });
  } catch (e) {
    if (e instanceof RangeError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[glossary] save failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not save that term." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const removed = await removeTerm(username, id);
  return removed ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
