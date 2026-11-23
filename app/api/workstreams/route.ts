/**
 * /api/workstreams — the user's workstreams, their routing rules, and filing
 * one thing by hand.
 *
 * GET                                  → { workstreams, rules }
 * POST { key, workstream, text?, learn? } → file one item (key = "action:<id>"
 *      or a Today item id); `learn: { field, value }` also adds a rule so the
 *      next one from that sender / domain / channel / project routes itself.
 *      workstream null clears the user's choice (back to automatic).
 * DELETE ?rule=<id>                    → forget a rule.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { readWorkstreams, setUserWorkstream, deleteRule } from "@/lib/workstreams/store";
import { WORKSTREAMS, isWorkstream, type WorkstreamRule } from "@/lib/workstreams/types";

const FIELDS: ReadonlyArray<WorkstreamRule["field"]> = ["sender", "domain", "channel", "keyword", "project"];

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const store = await readWorkstreams(username, { fresh: true });
  return NextResponse.json({ workstreams: WORKSTREAMS, rules: store.rules });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { // ci-ok: unparseable body → null → 400 below
    key?: unknown; workstream?: unknown; text?: unknown; learn?: { field?: unknown; value?: unknown };
  } | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key || key.length > 300) return NextResponse.json({ error: "key is required" }, { status: 400 });
  const workstream = body?.workstream === null ? null : isWorkstream(body?.workstream) ? body.workstream : undefined;
  if (workstream === undefined) return NextResponse.json({ error: "unknown workstream" }, { status: 400 });
  let learn: Pick<WorkstreamRule, "field" | "value"> | undefined;
  if (body?.learn) {
    const field = body.learn.field as WorkstreamRule["field"];
    const value = typeof body.learn.value === "string" ? body.learn.value.trim() : "";
    if (!FIELDS.includes(field) || !value || value.length > 200) return NextResponse.json({ error: "invalid rule" }, { status: 400 });
    learn = { field, value };
  }
  const store = await setUserWorkstream(username, key, workstream, {
    text: typeof body?.text === "string" ? body.text : undefined,
    learn,
  });
  return NextResponse.json({ ok: true, rules: store.rules });
}

export async function DELETE(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("rule");
  if (!id) return NextResponse.json({ error: "rule is required" }, { status: 400 });
  const found = await deleteRule(username, id);
  return found ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not found" }, { status: 404 });
}
