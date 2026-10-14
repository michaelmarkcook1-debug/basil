import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getUserSpendToday } from "@/lib/ai/spend-guard";

export const dynamic = "force-dynamic";

/** The signed-in user's own AI spend today vs their daily cap (sidebar gauge). */
export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    return NextResponse.json(await getUserSpendToday(username));
  } catch {
    return NextResponse.json({ error: "Spend is unavailable right now." }, { status: 503 });
  }
}
