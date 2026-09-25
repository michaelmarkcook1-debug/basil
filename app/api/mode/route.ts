/**
 * /api/mode — the active mode, kept with the user rather than the browser.
 *
 * Modes were localStorage-only, so Deep Work set on the laptop did nothing on
 * the phone and a fresh browser opened in no mode at all. The client still
 * caches locally for instant paint; this is the copy that travels.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { parseBody } from "@/lib/api/respond";
import { readUserStore, writeUserStore } from "@/lib/storage/user-store";
import { MODES } from "@/lib/modes/config";

export const dynamic = "force-dynamic";
const FILE = "sage-mode.json";

const StateSchema = z.object({
  active: z.string().refine((id) => id in MODES, "unknown mode"),
  activeSince: z.string().nullable(),
  activeUntil: z.string().nullable(),
  previousMode: z.string().nullable(),
});

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const state = await readUserStore<z.infer<typeof StateSchema> | null>(username, FILE, null);
  return NextResponse.json({ state });
}

export async function PUT(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const parsed = await parseBody(req, z.object({ state: StateSchema }));
  if (!parsed.ok) return parsed.response;
  await writeUserStore(username, FILE, parsed.data.state);
  return NextResponse.json({ ok: true });
}
