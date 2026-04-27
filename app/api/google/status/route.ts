import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";
import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/google/status
 *
 * Returns the normalized IntegrationStatus for Google.
 * Kept for backward compatibility — prefer /api/integrations/status for new callers.
 */
export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const status = await getGoogleConnectionStatus(username);
  return NextResponse.json(status);
}
