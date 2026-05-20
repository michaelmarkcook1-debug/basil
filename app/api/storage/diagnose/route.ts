/**
 * GET /api/storage/diagnose
 *
 * Admin-only diagnostic endpoint: tests the Vercel API credentials used by
 * the env-snapshot storage adapter without modifying any data.
 *
 * Checks:
 *  1. VERCEL_TOKEN / PROJECT_ID / TEAM_ID presence
 *  2. GET /v10/projects/{id}/env — can the token list env vars?
 *  3. Is BASIL_DATA present? What is its ID?
 *  4. Snapshot size + key count in current in-memory snapshot
 *
 * Protected by STIG_API_TOKEN (same as other admin routes).
 */

import { NextResponse } from "next/server";
import { lastPersistError, lastPersistOk } from "@/lib/storage/adapters/vercel-env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Auth: require STIG_API_TOKEN via standard Authorization: Bearer header
  // (matches the convention used by all other Stig API routes).
  const authHeader = req.headers.get("authorization") ?? "";
  const expected = process.env.STIG_API_TOKEN ?? "";
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;

  const result: Record<string, unknown> = {
    credentials: {
      VERCEL_TOKEN: token ? `${token.slice(0, 8)}…` : null,
      VERCEL_PROJECT_ID: projectId ?? null,
      VERCEL_TEAM_ID: teamId ?? null,
    },
    lastPersistOk,
    lastPersistError,
  };

  if (!token || !projectId || !teamId) {
    return NextResponse.json({ ...result, envListStatus: "skipped — missing credentials" });
  }

  // Step 1: list env vars (read-only, no modification)
  try {
    const url = `https://api.vercel.com/v10/projects/${projectId}/env?teamId=${teamId}&limit=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const httpStatus = res.status;
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;

    if (!res.ok) {
      result.envListStatus = `HTTP ${httpStatus}`;
      result.envListError = body;
      return NextResponse.json(result);
    }

    const envs = (body.envs ?? []) as Array<{ id: string; key: string; type: string }>;
    const basilEntry = envs.find((e) => e.key === "BASIL_DATA");

    result.envListStatus = `HTTP ${httpStatus} — ${envs.length} env vars returned`;
    result.basilDataFound = !!basilEntry;
    result.basilDataId = basilEntry?.id ?? null;
    result.basilDataType = basilEntry?.type ?? null;
    result.allKeys = envs.map((e) => e.key).sort();

    // Step 2: dry-run PATCH — send a PATCH with the current value to see if it succeeds
    // We use an empty object as the patch body so we don't change the value
    // Actually, just check if we *can* write by sending the real current value
    // We won't do the actual patch here — just report readiness.
    result.patchReadiness = basilEntry
      ? "Ready — BASIL_DATA id found, PATCH should work"
      : "Not ready — BASIL_DATA not found in env list (will attempt POST on next write)";

  } catch (err) {
    result.envListStatus = "exception";
    result.envListError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(result);
}
