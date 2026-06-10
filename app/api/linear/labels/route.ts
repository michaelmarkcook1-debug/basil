import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getLabels, isLinearConnected } from "@/lib/linear/client";

/**
 * GET /api/linear/labels?teamId=...
 *
 * Returns available Linear labels for the team (or all labels if no teamId).
 * Used by the dashboard to render the label multi-select on issues.
 */
export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ labels: [], connected: false });
  }

  try {
    const url = new URL(req.url);
    const teamId = url.searchParams.get("teamId") ?? undefined;
    const labels = await getLabels(username, teamId);
    return NextResponse.json({ labels, connected: true });
  } catch (e) {
    console.error("[linear/labels] failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Failed to load labels" }, { status: 502 });
  }
}
