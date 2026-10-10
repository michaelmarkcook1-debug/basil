/**
 * GET  /api/contacts/sentiment         — every stored relationship read (instant);
 *                                         stale ones are re-read after the response.
 * GET  /api/contacts/sentiment?id=<id> — one contact's read, judged now if there is
 *                                         something new (at most once a day).
 * POST /api/contacts/sentiment {id}    — re-read one contact now.
 */
import { NextResponse, after } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listUserContacts } from "@/lib/contacts/user-store";
import { assessRelationship, listSentiment, refreshStaleSentiment, MIN_INTERACTIONS } from "@/lib/contacts/sentiment";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function one(username: string, id: string, force: boolean) {
  const contact = (await listUserContacts(username)).find((c) => c.id === id);
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  try {
    const { sentiment, interactions } = await assessRelationship(username, contact, { force });
    return NextResponse.json({ sentiment, interactions, minInteractions: MIN_INTERACTIONS });
  } catch (e) {
    console.error("[contacts/sentiment] read failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Basil could not read this relationship right now." }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (id) return one(username, id, false);

  const sentiment = await listSentiment(username);
  after(async () => {
    try {
      const n = await refreshStaleSentiment(username);
      if (n) console.info(`[contacts/sentiment] re-read ${n} relationship(s) for ${username}`);
    } catch (e) {
      console.warn("[contacts/sentiment] background refresh failed:", e instanceof Error ? e.message : e);
    }
  });
  return NextResponse.json({ sentiment });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = await req.json().catch(() => ({})) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  return one(username, body.id, true);
}
