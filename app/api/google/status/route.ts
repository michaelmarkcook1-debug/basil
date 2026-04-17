import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";

// Returns per-scope Google connection status. A single OAuth token grants
// all three scopes, but the user may have revoked some server-side via
// Google's account settings — so we check the token's `scope` string.
export async function GET() {
  return NextResponse.json(getGoogleConnectionStatus());
}
