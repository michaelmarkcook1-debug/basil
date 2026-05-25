import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { markAllSeen } from "@/lib/delta/store";

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const baseline = await markAllSeen(username);
    return NextResponse.json({ ok: true, baseline });
  } catch (err) {
    console.error("[delta/seen] markAllSeen error", err);
    return NextResponse.json({ error: "Failed to update baseline" }, { status: 500 });
  }
}
