import { NextResponse } from "next/server";
import { getStatus } from "@/lib/whatsapp/dump-job";

// GET /api/whatsapp/dump/status — UI polls every second for QR + state
export async function GET() {
  return NextResponse.json({ status: getStatus() });
}
