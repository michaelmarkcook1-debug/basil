import { NextResponse, after } from "next/server";
import { startDump, getStatus } from "@/lib/whatsapp/dump-job";
import { getSessionUser } from "@/lib/auth";

// Explicitly allow up to 300 s — the sync waits up to 4 min for WhatsApp to
// push history, so we need the full Vercel function budget.
export const maxDuration = 300;

// POST /api/whatsapp/dump
// Kicks off a one-shot snapshot job for the authenticated user. Returns
// immediately — the UI polls /api/whatsapp/dump/status for QR + progress.
export async function POST() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const { jobId, task } = startDump(username);
  after(task);
  return NextResponse.json({ status: getStatus(username), jobId });
}
