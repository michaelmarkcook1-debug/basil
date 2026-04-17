import { NextResponse } from "next/server";
import { updateAction, deleteAction } from "@/lib/actions/store";
import type { ActionItem } from "@/lib/types/action";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const patch = (await req.json()) as Partial<
      Pick<ActionItem, "text" | "owner" | "ownerId" | "dueDate" | "status" | "source">
    >;
    const updated = await updateAction(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ action: updated });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const ok = await deleteAction(id);
  return NextResponse.json(
    { status: ok ? "deleted" : "not_found", id },
    { status: ok ? 200 : 404 }
  );
}
