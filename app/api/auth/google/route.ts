import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google/auth";

// GET /api/auth/google — redirects to Google OAuth consent screen
export async function GET() {
  const url = getAuthUrl();
  return NextResponse.redirect(url);
}
