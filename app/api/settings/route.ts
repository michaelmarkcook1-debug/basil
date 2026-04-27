import { NextResponse } from "next/server";
import { getSettings, patchSettings } from "@/lib/settings/store";
import { getSessionUser } from "@/lib/auth";
import type { UserSettings } from "@/lib/settings/store";

/** GET /api/settings — returns the full UserSettings object for the current user. */
export async function GET() {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const settings = await getSettings(username);
  return NextResponse.json(settings);
}

/**
 * PATCH /api/settings — writes a partial update for the current user.
 * Body: Partial<UserSettings> — only the supplied keys are changed.
 * Returns the full updated settings object.
 */
export async function PATCH(req: Request) {
  const username = (await getSessionUser());
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  let body: Partial<UserSettings>;
  try {
    body = (await req.json()) as Partial<UserSettings>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const updated = await patchSettings(username, body);
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Update failed";
    console.error("[api/settings] PATCH failed:", message);
    const isValidationError = message.startsWith("Invalid ");
    return NextResponse.json(
      { error: message },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
