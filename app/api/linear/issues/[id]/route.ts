import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, updateIssue } from "@/lib/linear/client";
import type { LinearIssueInput } from "@/lib/linear/client";

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
    const body = (await req.json()) as Partial<LinearIssueInput> & { stateId?: string };
    const issue = await updateIssue(username, id, body);
    return NextResponse.json({ issue });
  } catch (e) {
    console.error("[linear] updateIssue error:", e);
    return NextResponse.json({ error: "Failed to update issue" }, { status: 500 });
  }
}
