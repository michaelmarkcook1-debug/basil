import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listUserContacts } from "@/lib/contacts/user-store";
import { getAllOverridesFromStore } from "@/lib/contacts/overrides-store";
import { sampleContacts } from "@/lib/contacts-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/contacts/approach?names=Alice,Bob
 *
 * Compact "how to approach this person" hints — the influence layer made
 * ambient. For each requested name, returns a one-line hint distilled from the
 * contact's stored personality intelligence (whatMakesThemTick → personality →
 * watchOut, first sentence, clamped). No AI call — this reads what Basil
 * already knows, so it's cheap enough to render beside any name.
 *
 * Response: { hints: { name, contactId, hint, watchOut }[] }
 */

function firstSentence(text: string | undefined, max = 110): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned || /^SAMPLE placeholder/i.test(cleaned)) return null;
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  const namesParam = new URL(req.url).searchParams.get("names") ?? "";
  const names = namesParam.split(",").map((n) => n.trim()).filter(Boolean).slice(0, 25);
  if (names.length === 0) return NextResponse.json({ hints: [] });

  const [userContacts, overrides] = await Promise.all([
    listUserContacts(username).catch(() => []), // ci-ok: no contacts → no hints
    getAllOverridesFromStore(username).catch(() => ({})), // ci-ok: no overrides → seed/profile fields only
  ]);
  const all = [...sampleContacts(), ...userContacts];

  const hints = names.flatMap((name) => {
    const lower = name.toLowerCase();
    const contact = all.find((c) => {
      const full = c.name.trim().toLowerCase();
      const first = full.split(" ")[0];
      return full === lower || lower.includes(full) || (first.length > 2 && lower.startsWith(first));
    });
    if (!contact) return [];
    const ov = (overrides as Record<string, { whatMakesThemTick?: string; personality?: string; watchOut?: string }>)[contact.id] ?? {};
    const c = contact as { whatMakesThemTick?: string; personality?: string; watchOut?: string };
    const hint = firstSentence(ov.whatMakesThemTick ?? c.whatMakesThemTick) ?? firstSentence(ov.personality ?? c.personality);
    const watchOut = firstSentence(ov.watchOut ?? c.watchOut, 90);
    if (!hint && !watchOut) return [];
    return [{ name: contact.name, contactId: contact.id, hint, watchOut }];
  });

  return NextResponse.json({ hints });
}
