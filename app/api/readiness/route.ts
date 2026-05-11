import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getReadiness } from "@/lib/readiness";

export async function GET() {
  const username = await getSessionUser();
  if (!username) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const report = await getReadiness(username);
    return NextResponse.json(report);
  } catch (e) {
    console.error("[readiness] GET error:", e);
    return NextResponse.json({ error: "Failed to compute readiness" }, { status: 500 });
  }
}
