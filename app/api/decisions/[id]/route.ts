import { NextResponse } from "next/server";
import { updateDecision, deleteDecision } from "@/lib/decisions/store";
import type { Decision } from "@/lib/types/decision";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await ctx.params;
    const patch = (await req.json()) as Partial<
      Pick<Decision, "text" | "decidedBy" | "decidedById" | "date" | "context" | "status">
    >;
    const updated = await updateDecision(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ decision: updated });
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
  const ok = await deleteDecision(id);
  return NextResponse.json(
    { status: ok ? "deleted" : "not_found", id },
    { status: ok ? 200 : 404 }
  );
}
