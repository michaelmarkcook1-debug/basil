import { NextResponse } from "next/server";
import { updateDecision, deleteDecision } from "@/lib/decisions/store";
import type { Decision } from "@/lib/types/decision";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    ({ id } = await ctx.params);
    const patch = (await req.json()) as Partial<
      Pick<
        Decision,
        | "text"
        | "title"
        | "summary"
        | "rationale"
        | "alternatives"
        | "consequences"
        | "decidedBy"
        | "decidedById"
        | "stakeholders"
        | "date"
        | "context"
        | "status"
        | "source"
        | "confidence"
        | "needsReview"
        | "reviewDismissedAt"
        | "tags"
        | "linkedActionIds"
      >
    >;
    const updated = await updateDecision(id, patch);
    if (!updated) {
      console.warn(`[decisions/${id}] PATCH: not found`);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ decision: updated });
  } catch (e) {
    console.error(`[decisions/${id}] PATCH: error —`, e);
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
  let id = "";
  try {
    ({ id } = await ctx.params);
    const ok = await deleteDecision(id);
    return NextResponse.json(
      { status: ok ? "deleted" : "not_found", id },
      { status: ok ? 200 : 404 }
    );
  } catch (e) {
    console.error(`[decisions/${id}] DELETE: error —`, e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
