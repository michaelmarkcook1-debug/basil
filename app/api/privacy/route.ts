/**
 * /api/privacy — people profiles (lib/privacy).
 *
 *   GET     { profiling, optedOut: [{ id, name, at }] }
 *   PATCH   { profiling: boolean } — build people profiles at all
 *   POST    { contactId, name, notes?, memories?, optOut? } — forget what Basil
 *           inferred about one person (and by default stop profiling them)
 *   DELETE  ?contactId=… — let Basil profile that person again
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getPrivacy, optInContact, setProfiling } from "@/lib/privacy/store";
import { forgetPerson } from "@/lib/privacy/forget";
import type { PrivacyState } from "@/lib/privacy/rules";

export const dynamic = "force-dynamic";

function view(p: PrivacyState) {
  return {
    profiling: p.profiling,
    optedOut: Object.entries(p.optedOut).map(([id, v]) => ({ id, name: v.name, at: v.at })),
  };
}

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  return NextResponse.json(view(await getPrivacy(username)));
}

export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { profiling?: unknown };
  if (typeof body.profiling !== "boolean") return NextResponse.json({ error: "profiling must be true or false" }, { status: 400 });
  return NextResponse.json(view(await setProfiling(username, body.profiling)));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { contactId?: unknown; name?: unknown; notes?: unknown; memories?: unknown; optOut?: unknown };
  const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!contactId || contactId.length > 200 || !name) return NextResponse.json({ error: "Which person?" }, { status: 400 });
  const result = await forgetPerson(username, { id: contactId, name }, {
    notes: body.notes === true,
    memories: body.memories === true,
    optOut: body.optOut !== false,
  });
  return NextResponse.json({ ok: true, ...result, privacy: view(await getPrivacy(username)) });
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const contactId = new URL(req.url).searchParams.get("contactId") ?? "";
  if (!contactId) return NextResponse.json({ error: "Which person?" }, { status: 400 });
  return NextResponse.json(view(await optInContact(username, contactId)));
}
