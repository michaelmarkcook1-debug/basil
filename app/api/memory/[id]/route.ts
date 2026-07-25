import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteMemory, updateMemory, listMemories } from "@/lib/memory/store";
import { forceFlushSnapshot } from "@/lib/storage/persistent";
import { getSessionUser } from "@/lib/auth";
import { parseBody } from "@/lib/api/respond";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await ctx.params;
  const all = await listMemories(username);
  const memory = all.find((m) => m.id === id);
  if (!memory) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ memory });
}

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
  // POST validates `kind` against the allowed set; PATCH did not, so a PATCH
  // could write an arbitrary kind (or any other key, via the bare cast) into a
  // stored memory and break every kind-based filter downstream.
  const parsed = await parseBody(
    req,
    z.object({
      content: z.string().min(1).optional(),
      kind: z.enum(["fact", "preference", "person", "context"]).optional(),
      entity: z.string().optional(),
    })
  );
  if (!parsed.ok) return parsed.response;
  const updated = await updateMemory(username, id, parsed.data);
  if (!updated)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  await forceFlushSnapshot();
  return NextResponse.json({ memory: updated });
}
