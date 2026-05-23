import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminUser } from "@/lib/users";
import { getFlagsFresh, setFlag, validateFlagKey } from "@/core/feature-flags";

/**
 * GET /api/admin/feature-flags
 * Returns current feature flags for the authenticated admin user.
 */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const flags = await getFlagsFresh(username);
  return NextResponse.json({ flags });
}

/**
 * PATCH /api/admin/feature-flags
 * Set a single feature flag. Rollback takes effect within 60 seconds
 * (cache TTL) or immediately on the next getFlags() call after the write.
 *
 * Body: { key: string, value: boolean }
 * Examples:
 *   { "key": "signalEvent_shadow", "value": true }
 *   { "key": "sources.gmail_cutover", "value": true }
 */
export async function PATCH(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  if (!isAdminUser(username)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { key?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { key, value } = body;

  if (typeof key !== "string" || key.trim() === "") {
    return NextResponse.json({ error: "key must be a non-empty string" }, { status: 400 });
  }
  if (typeof value !== "boolean") {
    return NextResponse.json({ error: "value must be a boolean" }, { status: 400 });
  }

  const validationError = validateFlagKey(key);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  await setFlag(username, key, value);

  const updated = await getFlagsFresh(username);
  console.info(`[feature-flags] ${username} set ${key}=${value}`);

  return NextResponse.json({ ok: true, flags: updated });
}
