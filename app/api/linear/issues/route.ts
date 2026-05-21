import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, getAllIssues, createIssue } from "@/lib/linear/client";
import type { LinearIssueInput } from "@/lib/linear/client";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const teamId = searchParams.get("teamId") ?? undefined;
  const stateType = searchParams.get("stateType") ?? undefined;
  const assigneeIsMeStr = searchParams.get("assigneeIsMe");
  const assigneeIsMe = assigneeIsMeStr === "true" ? true : undefined;

  const issues = await getAllIssues(username, { teamId, stateType, assigneeIsMe });
  return NextResponse.json({ issues });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  try {
    const body = (await req.json()) as LinearIssueInput;
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (!body.teamId) {
      return NextResponse.json({ error: "teamId is required" }, { status: 400 });
    }
    const issue = await createIssue(username, body);
    return NextResponse.json({ issue }, { status: 201 });
  } catch (e) {
    console.error("[linear] createIssue error:", e);
    return NextResponse.json({ error: "Failed to create issue" }, { status: 500 });
  }
}
