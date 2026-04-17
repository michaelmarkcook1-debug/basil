import { NextResponse } from "next/server";
import { deleteMemory, updateMemory } from "@/lib/memory/store";
import type { MemoryKind } from "@/lib/memory/types";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await deleteMemory(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const body = (await req.json()) as Partial<{
    content: string;
    kind: MemoryKind;
    entity: string;
  }>;
  const updated = await updateMemory(id, body);
  if (!updated)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ memory: updated });
}
