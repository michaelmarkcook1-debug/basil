import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isLinearConnected, getTeams } from "@/lib/linear/client";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isLinearConnected(username))) {
    return NextResponse.json({ error: "Linear not connected" }, { status: 503 });
  }

  const teams = await getTeams(username);
  return NextResponse.json({ teams });
}
