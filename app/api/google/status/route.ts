import { NextResponse } from "next/server";
import { getGoogleConnectionStatus } from "@/lib/google/auth";

/**
 * GET /api/google/status
 *
 * Returns the normalized IntegrationStatus for Google.
 * Kept for backward compatibility — prefer /api/integrations/status for new callers.
 */
export async function GET() {
  const status = await getGoogleConnectionStatus();
  return NextResponse.json(status);
}
