import { NextResponse } from "next/server";
import { getStigRequestUser } from "@/lib/stig/auth";
import { buildStigStatus } from "@/lib/stig/status";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const user = await getStigRequestUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const status = await buildStigStatus(user.username);
    return NextResponse.json({ ...status, authMode: user.authMode });
  } catch (err) {
    console.error("[api/stig/status] failed:", err);
    return NextResponse.json(
      { error: "Stig status check failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
