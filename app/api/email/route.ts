import { NextResponse } from "next/server";
import { isGoogleConnected } from "@/lib/google/auth";
import { getRecentEmails } from "@/lib/google/gmail";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  if (!(await isGoogleConnected(username))) {
    return NextResponse.json({
      connected: false,
      emails: [],
      message: "Gmail not connected. Set up OAuth in Settings.",
    });
  }

  try {
    const emails = await getRecentEmails(username, 8);
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
      message: "Gmail error — please try again",
    });
  }
}
