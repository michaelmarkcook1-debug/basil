import { NextResponse } from "next/server";
import {
  setOverrideInStore,
  clearOverrideFromStore,
} from "@/lib/contacts/overrides-store";
import { z } from "zod";
import { parseBody } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth";

/**
 * PUT /api/contacts/overrides/:id
 * Body: ProfileOverride  → merges patch into stored override for this contact.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    // Was a whole-body `as ProfileOverride` cast written straight to the store.
    // toneHistory is the one that matters: it feeds the warming/cooling signals
    // on the home feed, so a malformed entry corrupts relationship intelligence.
    const parsed = await parseBody(
      req,
      z.object({
        personality: z.string().optional(),
        whatMakesThemTick: z.string().optional(),
        watchOut: z.string().optional(),
        recentActivity: z.string().optional(),
        activitySource: z.string().optional(),
        generatedAt: z.string().optional(),
        summary: z.string().optional(),
        toneHistory: z
          .array(
            z.object({
              date: z.string(),
              person: z.string(),
              direction: z.enum(["warming", "cooling", "neutral"]),
              summary: z.string(),
              source: z.enum(["email", "slack", "zoom"]),
            })
          )
          .optional(),
      })
    );
    if (!parsed.ok) return parsed.response;
    const merged = await setOverrideInStore(username, id, parsed.data);
    return NextResponse.json({ override: merged });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/contacts/overrides/:id
 * Clears the AI-generated override for this contact (falls back to seed data).
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const { id } = await params;
    await clearOverrideFromStore(username, id);
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
