import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { updateLedgerItem, deleteLedgerItem } from "@/lib/ledger/store";
import type { LedgerItem } from "@/lib/ledger/types";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await params;
  let updates: Partial<LedgerItem>;
  try {
    updates = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const updated = await updateLedgerItem(username, id, updates);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ item: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await params;
  const deleted = await deleteLedgerItem(username, id);
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
