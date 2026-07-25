import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, updateIssue } from "@/lib/linear/client";
import { z } from "zod";
import { parseBody } from "@/lib/api/respond";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  try {
    const { id } = await params;
    // stateId and friends were forwarded raw to the Linear API. Validate shape
    // here so a malformed body fails as a clean 400 rather than an opaque
    // upstream 500 (or an unintended mutation on the user's real workspace).
    const parsed = await parseBody(
      req,
      z.object({
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        stateId: z.string().optional(),
        priority: z.number().int().min(0).max(4).optional(),
        assigneeId: z.string().optional(),
        dueDate: z.string().optional(),
        teamId: z.string().optional(),
        projectId: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
      })
    );
    if (!parsed.ok) return parsed.response;
    const issue = await updateIssue(username, id, parsed.data);
    return NextResponse.json({ issue });
  } catch (e) {
    console.error("[linear] updateIssue error:", e);
    return NextResponse.json({ error: "Failed to update issue" }, { status: 500 });
  }
}
