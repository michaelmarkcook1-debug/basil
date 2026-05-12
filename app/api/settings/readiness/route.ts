import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildStigStatus } from "@/lib/stig/status";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const status = await buildStigStatus(username);

    // Compute overall readiness score
    const checks = [
      status.model.gatewayReady,
      status.appSources.slack.state === "connected",
      status.appSources.google.state === "connected",
    ];
    const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);

    return NextResponse.json({
      ...status,
      readiness: { score, checks },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[settings/readiness] error:", err);
    return NextResponse.json({ error: "Readiness check failed" }, { status: 500 });
  }
}
