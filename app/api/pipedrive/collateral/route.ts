/**
 * GET /api/pipedrive/collateral?deal=<id> | ?q=<name, company or email>
 * Suggested collateral for a deal and a ready-to-paste prompt for each.
 * Basil suggests and writes prompts; it does not create the collateral.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { collateralFor } from "@/lib/pipedrive/collateral-server";

export async function GET(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const url = new URL(req.url);
  const deal = Number(url.searchParams.get("deal"));
  const q = url.searchParams.get("q") ?? undefined;
  if (!Number.isFinite(deal) && !q) return NextResponse.json({ error: "deal or q is required" }, { status: 400 });
  return NextResponse.json(await collateralFor(username, { ...(Number.isFinite(deal) && deal > 0 ? { dealId: deal } : {}), ...(q ? { query: q.slice(0, 200) } : {}) }));
}
