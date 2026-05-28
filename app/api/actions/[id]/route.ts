import { NextResponse } from "next/server";
import { updateAction, deleteAction } from "@/lib/actions/store";
import type { ActionItem } from "@/lib/types/action";
import { getSessionUser } from "@/lib/auth";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    ({ id } = await ctx.params);
    const patch = (await req.json()) as Partial<
      Pick<
        ActionItem,
        | "text"
        | "owner"
        | "ownerId"
        | "dueDate"
        | "status"
        | "source"
        | "priority"
        | "confidence"
        | "needsReview"
        | "reviewDismissedAt"
        | "linkedDecisionIds"
        | "followUpDate"
        | "lastActivityAt"
        | "eisenhower"
        | "eisenhowerReason"
        | "eisenhowerClassifiedAt"
      >
    >;
    const updated = await updateAction(username, id, patch);
    if (!updated) {
      console.warn(`[actions/${id}] PATCH: not found`);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ action: updated });
  } catch (e) {
    console.error(`[actions/${id}] PATCH: error —`, e);
    return NextResponse.json(
      { error: "Operation failed" },
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
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    ({ id } = await ctx.params);
    const ok = await deleteAction(username, id);
    return NextResponse.json(
      { status: ok ? "deleted" : "not_found", id },
      { status: ok ? 200 : 404 }
    );
  } catch (e) {
    console.error(`[actions/${id}] DELETE: error —`, e);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
