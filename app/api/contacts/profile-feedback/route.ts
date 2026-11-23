/**
 * /api/contacts/profile-feedback — grading profiles (lib/contacts/profile-feedback).
 *
 * GET                                          → the quality summary
 * POST { contactId, field, text, verdict }     → thumbs up / down on one claim;
 *      verdict "clear" removes it. The next draft for that contact treats an
 *      up as a stated fact and a down as "do not repeat".
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { qualitySummary, recordVerdict, readFeedback } from "@/lib/contacts/profile-feedback";
import { PROFILE_FIELDS, type ProfileField } from "@/lib/contacts/profile-evidence";
import { updateUserStore } from "@/lib/storage/user-store";
import type { FeedbackStore } from "@/lib/contacts/profile-quality";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const contactId = new URL(req.url).searchParams.get("contactId");
  if (contactId) {
    // This contact's verdicts, so the cards can show which claims were marked.
    const store = await readFeedback(username, { fresh: true });
    return NextResponse.json({ verdicts: store.verdicts.filter((v) => v.contactId === contactId) });
  }
  return NextResponse.json(await qualitySummary(username));
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as { contactId?: unknown; field?: unknown; text?: unknown; verdict?: unknown } | null; // ci-ok: unparseable body → null → 400 below
  const contactId = typeof b?.contactId === "string" ? b.contactId.trim() : "";
  const field = b?.field as ProfileField;
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  if (!contactId || contactId.length > 200 || !PROFILE_FIELDS.includes(field) || !text || text.length > 600) {
    return NextResponse.json({ error: "contactId, field and text are required" }, { status: 400 });
  }
  if (b?.verdict === "clear") {
    await updateUserStore<FeedbackStore>(username, "profile-feedback.json", (cur) => ({
      verdicts: (cur?.verdicts ?? []).filter((v) => !(v.contactId === contactId && v.field === field && v.text === text)),
      runs: cur?.runs ?? [],
    }), { verdicts: [], runs: [] }, { allowShrink: true });
    return NextResponse.json({ ok: true });
  }
  if (b?.verdict !== "up" && b?.verdict !== "down") return NextResponse.json({ error: "verdict must be up, down or clear" }, { status: 400 });
  await recordVerdict(username, { contactId, field, text, verdict: b.verdict });
  return NextResponse.json({ ok: true });
}
