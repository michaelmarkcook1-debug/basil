import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getRecentEmails } from "@/lib/google/gmail";

export async function GET() {
  if (!(await isGoogleConnected())) {
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const emails = await getRecentEmails(8);
    return NextResponse.json({
      connected: true,
      emails,
      message: emails.length === 0 ? "No recent emails." : `${emails.length} recent emails.`,
    });
  } catch (e) {
    console.error("Gmail API error:", e);
    return NextResponse.json({
      connected: false,
      emails: [],
      message: `Gmail error: ${e instanceof Error ? e.message : "Unknown"}`,
    });
  }
}
