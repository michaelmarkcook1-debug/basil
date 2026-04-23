import { NextResponse } from "next/server";
import { getMicrosoftAuthUrl } from "@/lib/microsoft/auth";

// GET /api/auth/microsoft — redirects to Microsoft OAuth consent screen
export async function GET() {
  if (!process.env.MICROSOFT_CLIENT_ID) {
    return NextResponse.json(
      { error: "MICROSOFT_CLIENT_ID not configured" },
      { status: 503 }
    );
  }

  const url = getMicrosoftAuthUrl();
  return NextResponse.redirect(url);
}
