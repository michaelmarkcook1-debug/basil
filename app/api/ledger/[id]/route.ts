import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateLedgerItem, deleteLedgerItem } from "@/lib/ledger/store";
import { parseBody } from "@/lib/api/respond";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await params;
  // Was a fully untyped `await req.json()` assigned to Partial<LedgerItem> —
  // any key, any type, straight into the store. Identity and provenance fields
  // (id, type, source, createdBy, createdAt) are deliberately NOT patchable.
  const parsed = await parseBody(
    req,
    z.object({
      title: z.string().min(1).optional(),
      summary: z.string().optional(),
      status: z.enum(["open", "in_progress", "done", "cancelled", "blocked"]).optional(),
      dueAt: z.string().optional(),
      urgency: z.enum(["low", "medium", "high", "critical"]).optional(),
      relatedPeople: z.array(z.string()).optional(),
      relatedProjects: z.array(z.string()).optional(),
      confidence: z.number().min(0).max(1).optional(),
    })
  );
  if (!parsed.ok) return parsed.response;
  const updated = await updateLedgerItem(username, id, parsed.data);
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
