import { NextResponse } from "next/server";
import { getSettings, patchSettings } from "@/lib/settings/store";
import type { UserSettings } from "@/lib/settings/store";

/** GET /api/settings — returns the full UserSettings object. */
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(settings);
}

/**
 * PATCH /api/settings — writes a partial update.
 * Body: Partial<UserSettings> — only the supplied keys are changed.
 * Returns the full updated settings object.
 *
 * Validation errors (e.g. invalid timezone) → 400 Bad Request.
 * System errors (e.g. store write failure) → 500 Internal Server Error.
 */
export async function PATCH(req: Request) {
  let body: Partial<UserSettings>;
  try {
    body = (await req.json()) as Partial<UserSettings>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const updated = await patchSettings(body);
    return NextResponse.json(updated);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Update failed";
    console.error("[api/settings] PATCH failed:", message);

    // Validation errors from patchSettings start with "Invalid" and should
    // be returned to the client as 400 so the UI can display them.
    const isValidationError =
      message.startsWith("Invalid timezone") ||
      message.startsWith("Invalid ");

    return NextResponse.json(
      { error: message },
      { status: isValidationError ? 400 : 500 }
    );
  }
}
