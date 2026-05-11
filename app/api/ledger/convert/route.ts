import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getLedger } from "@/lib/ledger/store";
import { convertLedgerItem } from "@/lib/ledger/convert";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import type { LedgerConvertRequest } from "@/lib/ledger/types";

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: LedgerConvertRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const items = await getLedger(username);
  const item = items.find((i) => i.id === body.ledgerItemId);
  if (!item) return NextResponse.json({ error: "Ledger item not found" }, { status: 404 });

  const result = await convertLedgerItem(username, item, body);
  if (result.ok) await forceFlushSnapshot();
  return NextResponse.json(result, { status: result.ok ? 200 : 422 });
}
