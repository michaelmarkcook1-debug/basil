import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { validateParityGates, PARITY_GATES } from "@/core/ingestion/parity-validator";

/**
 * GET /api/admin/parity-status
 *
 * Returns the full parity report for the authenticated admin user.
 * Shows whether all cutover gates are satisfied and why/why not.
 *
 * Response:
 * {
 *   report: ParityReport,   // full gate-by-gate breakdown
 *   thresholds: {           // the gate constants (for UI display)
 *     exactMatchRate: 0.90,
 *     criticalDiffRate: 0.02,
 *     minShadowDays: 14,
 *     minSampleSize: 50,
 *   }
 * }
 *
 * HTTP status:
 *   200  — report returned (even if cutoversAllowed is false)
 *   401  — unauthenticated
 *   403  — not an admin user
 *   500  — failed to read shadow log
 *
 * This is a read-only diagnostic endpoint. It never enables cutover —
 * cutover is controlled exclusively via PATCH /api/admin/feature-flags.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let report;
  try {
    report = await validateParityGates(username);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[parity-status] validation failed for ${username}:`, msg);
    return NextResponse.json({ error: "Failed to compute parity report" }, { status: 500 });
  }

  console.info(
    `[parity-status] ${username} — cutoversAllowed=${report.cutoversAllowed} ` +
    `exactMatchRate=${report.metrics.exactMatchRate.toFixed(3)} ` +
    `shadowDays=${report.shadowDays.toFixed(1)}`
  );

  return NextResponse.json({ report, thresholds: PARITY_GATES });
}
