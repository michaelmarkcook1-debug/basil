import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getLedger, saveLedgerItem } from "@/lib/ledger/store";
import { randomUUID } from "crypto";
import type { LedgerItem } from "@/lib/ledger/types";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const items = await getLedger(username);
  return NextResponse.json({ items });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: Partial<LedgerItem>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const item: LedgerItem = {
    id: body.id ?? randomUUID(),
    type: body.type ?? "action",
    title: body.title ?? "Untitled",
    summary: body.summary,
    source: body.source ?? "manual",
    sourceIds: body.sourceIds ?? [],
    sourceRef: body.sourceRef,
    relatedPeople: body.relatedPeople ?? [],
    relatedProjects: body.relatedProjects ?? [],
    status: body.status ?? "open",
    createdAt: body.createdAt ?? now,
    updatedAt: now,
    dueAt: body.dueAt,
    confidence: body.confidence,
    urgency: body.urgency,
    createdBy: body.createdBy ?? "user",
    workspace: body.workspace,
  };

  await saveLedgerItem(username, item);
  return NextResponse.json({ item }, { status: 201 });
}
