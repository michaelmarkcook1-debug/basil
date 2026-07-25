import { NextResponse } from "next/server";
import { updateDecision, deleteDecision } from "@/lib/decisions/store";
import { z } from "zod";
import { parseBody } from "@/lib/api/respond";
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
    // Validated + unknown-key-stripped. The array fields (alternatives,
    // consequences, stakeholders, tags, linkedActionIds) are the sharp edge:
    // a bare cast let a string through, which every downstream .map/.join
    // consumer then crashed on or rendered as garbage.
    const parsed = await parseBody(
      req,
      z.object({
        text: z.string().min(1).optional(),
        title: z.string().optional(),
        summary: z.string().optional(),
        rationale: z.string().optional(),
        alternatives: z.array(z.string()).optional(),
        consequences: z.array(z.string()).optional(),
        decidedBy: z.string().optional(),
        decidedById: z.string().optional(),
        stakeholders: z.array(z.string()).optional(),
        date: z.string().optional(),
        context: z.string().optional(),
        status: z.enum(["active", "superseded"]).optional(),
        source: z.enum(["meeting", "slack", "teams", "email", "manual", "chat"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        needsReview: z.boolean().optional(),
        reviewDismissedAt: z.string().optional(),
        tags: z.array(z.string()).optional(),
        linkedActionIds: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
    );
    if (!parsed.ok) return parsed.response;
    const updated = await updateDecision(username, id, parsed.data);
    if (!updated) {
      console.warn(`[decisions/${id}] PATCH: not found`);
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ decision: updated });
  } catch (e) {
    console.error(`[decisions/${id}] PATCH: error —`, e);
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
    const ok = await deleteDecision(username, id);
    return NextResponse.json(
      { status: ok ? "deleted" : "not_found", id },
      { status: ok ? 200 : 404 }
    );
  } catch (e) {
    console.error(`[decisions/${id}] DELETE: error —`, e);
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
