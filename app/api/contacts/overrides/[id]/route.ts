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
        ownerNotes: z.string().max(4000).optional(),
        changes: z.string().optional(),
        // Cited claims + the items they cite (lib/contacts/profile-evidence). Shape is
        // produced by our own code; bounded here so a client cannot store an essay.
        profileEvidence: z
          .object({
            claims: z.record(z.enum(["personality", "whatMakesThemTick", "watchOut", "recentActivity", "howToLandIt", "reachThem", "decides", "badNews", "silence"]), z.array(z.object({ text: z.string().max(600), evidence: z.array(z.string().max(8)).max(20) })).max(12)),
            cited: z.array(z.object({ id: z.string().max(8), by: z.enum(["them", "others", "stated", "measured"]), channel: z.string().max(16), date: z.string().max(10).optional(), label: z.string().max(120), excerpt: z.string().max(300) })).max(120),
            strength: z.record(z.enum(["personality", "whatMakesThemTick", "watchOut", "recentActivity", "howToLandIt", "reachThem", "decides", "badNews", "silence"]), z.object({ level: z.enum(["stated", "strong", "some", "thin"]), items: z.number(), days: z.number(), channels: z.number() })),
            dropped: z.array(z.object({ field: z.enum(["personality", "whatMakesThemTick", "watchOut", "recentActivity", "howToLandIt", "reachThem", "decides", "badNews", "silence"]), text: z.string().max(600), why: z.enum(["no-valid-citation", "style-without-their-words", "checker-unsupported", "checker-contradicted"]) })).max(40),
            checked: z.boolean().optional(),
          })
          .optional(),
        // "How to work with them" fields (lib/contacts/profile-evidence WORKING_FIELDS).
        workingStyle: z
          .object({
            howToLandIt: z.string().max(400).optional(),
            reachThem: z.string().max(1200).optional(),
            decides: z.string().max(1200).optional(),
            badNews: z.string().max(1200).optional(),
            silence: z.string().max(1200).optional(),
          })
          .optional(),
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
