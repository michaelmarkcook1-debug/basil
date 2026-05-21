import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, getWorkflowStates } from "@/lib/linear/client";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const teamId = searchParams.get("teamId") ?? undefined;

  const states = await getWorkflowStates(username, teamId);
  return NextResponse.json({ states });
}
