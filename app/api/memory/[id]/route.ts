import { NextResponse } from "next/server";
import { deleteMemory, updateMemory } from "@/lib/memory/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";
import type { MemoryKind } from "@/lib/memory/types";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await ctx.params;
  const ok = await deleteMemory(username, id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Flush snapshot synchronously so BASIL_DATA is current before the client
  // re-fetches — prevents a cold Vercel instance from restoring stale data.
  await forceFlushSnapshot();
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json()) as Partial<{
    content: string;
    kind: MemoryKind;
    entity: string;
  }>;
  const updated = await updateMemory(username, id, body);
  if (!updated)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  await forceFlushSnapshot();
  return NextResponse.json({ memory: updated });
}
