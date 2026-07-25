import { NextResponse } from "next/server";
import { z } from "zod";
import { updateAction, deleteAction } from "@/lib/actions/store";
import { getSessionUser } from "@/lib/auth";
import { parseBody } from "@/lib/api/respond";

/**
 * The PATCH body was previously a bare `as Partial<Pick<ActionItem, …>>` cast.
 * That is a COMPILE-TIME assertion only — and `updateAction` applies the patch
 * with a raw spread (`{ ...items[idx], ...patch }`), so at runtime any key and
 * any value type in the JSON landed straight in the stored record: `id` could
 * be overwritten, `status` set to a number (breaking every filter),
 * `linkedDecisionIds` set to a string (breaking every consumer), and arbitrary
 * junk keys persisted forever.
 *
 * Zod both VALIDATES the types and STRIPS unknown keys, so only these fields
 * can ever reach the store.
 */
const PatchSchema = z.object({
  text: z.string().min(1).optional(),
  owner: z.string().optional(),
  ownerId: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.enum(["open", "done", "overdue"]).optional(),
  source: z.enum(["meeting", "slack", "teams", "email", "manual", "chat", "linear"]).optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  needsReview: z.boolean().optional(),
  reviewDismissedAt: z.string().optional(),
  linkedDecisionIds: z.array(z.string()).optional(),
  followUpDate: z.string().optional(),
  lastActivityAt: z.string().optional(),
  eisenhower: z.enum(["Q1", "Q2", "Q3", "Q4"]).optional(),
  eisenhowerReason: z.string().optional(),
  eisenhowerClassifiedAt: z.string().optional(),
  notes: z.string().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  let id = "";
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    ({ id } = await ctx.params);
    const parsed = await parseBody(req, PatchSchema);
    if (!parsed.ok) return parsed.response;
    const updated = await updateAction(username, id, parsed.data);
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
