/**
 * POST /api/actions/capture-promises — file promises from your recent sent mail
 * as actions to confirm (lib/commitments/capture.ts). Fired when the Actions
 * page opens; at most once per MIN_INTERVAL_MINUTES, and the 05:45 ingest runs it daily.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isGoogleConnected } from "@/lib/google/auth";
import { captureSentPromises } from "@/lib/commitments/capture";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!(await isGoogleConnected(username))) return NextResponse.json({ scanned: 0, created: 0, connected: false });
  try {
    return NextResponse.json(await captureSentPromises(username));
  } catch (err) {
    console.error("[actions/capture-promises] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not read your sent mail." }, { status: 502 });
  }
}
