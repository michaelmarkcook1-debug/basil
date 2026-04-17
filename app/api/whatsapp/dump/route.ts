import { NextResponse } from "next/server";
import { startDump, getStatus } from "@/lib/whatsapp/dump-job";

// POST /api/whatsapp/dump
// Kicks off a one-shot snapshot job. Returns immediately — the UI polls
// /api/whatsapp/dump/status for QR + progress.
export async function POST() {
  await startDump();
  return NextResponse.json({ status: getStatus() });
}
