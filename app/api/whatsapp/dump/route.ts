import { NextResponse, after } from "next/server";
import { startDump, getStatus } from "@/lib/whatsapp/dump-job";

// Explicitly allow up to 300 s — the sync waits up to 4 min for WhatsApp to
// push history, so we need the full Vercel function budget.
export const maxDuration = 300;

// POST /api/whatsapp/dump
// Kicks off a one-shot snapshot job. Returns immediately — the UI polls
// /api/whatsapp/dump/status for QR + progress.
//
// The background sync task is registered with after() so Vercel keeps this
// instance alive for the full duration of the dump even after the HTTP
// response has been sent. Without this, Vercel can recycle the instance as
// soon as the 200 is delivered, killing the WhatsApp WebSocket mid-sync.
export async function POST() {
  const { task } = startDump();
  after(task);
  return NextResponse.json({ status: getStatus() });
}
