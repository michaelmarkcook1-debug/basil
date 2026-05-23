import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, getIssueComments, createComment } from "@/lib/linear/client";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  const { id } = await params;
  const comments = await getIssueComments(username, id);
  return NextResponse.json({ comments });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  const { id } = await params;
  const body = (await req.json()) as { body?: string };

  if (!body.body?.trim()) {
    return NextResponse.json({ error: "body is required" }, { status: 400 });
  }

  try {
    const comment = await createComment(username, id, body.body.trim());
    return NextResponse.json({ comment }, { status: 201 });
  } catch (e) {
    console.error("[linear] createComment error:", e);
    return NextResponse.json({ error: "Failed to create comment" }, { status: 500 });
  }
}
