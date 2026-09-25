/**
 * /api/trust — what Basil may do without asking, and how the asking has gone.
 *
 * GET  → { summary, delegations, offers, reversible, months }
 * POST { tool, action: "delegate" | "revoke" } → { delegations }
 *
 * Delegation is the user's decision, made here or on the approval card once
 * Basil has earned an offer. It is visible and reversible on the learning page.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { parseBody } from "@/lib/api/respond";
import { getLedger, setDelegation, summarize, monthly, REVERSIBLE_TOOLS } from "@/lib/trust/ledger";

export const dynamic = "force-dynamic";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const ledger = await getLedger(username);
  const summary = summarize(ledger);
  return NextResponse.json({
    summary,
    delegations: ledger.delegations,
    offers: Object.values(summary).filter((t) => t.offer).map((t) => t.tool),
    reversible: [...REVERSIBLE_TOOLS],
    months: monthly(ledger),
  });
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const parsed = await parseBody(req, z.object({ tool: z.string().min(1).max(64), action: z.enum(["delegate", "revoke"]) }));
  if (!parsed.ok) return parsed.response;
  try {
    const delegations = await setDelegation(username, parsed.data.tool, parsed.data.action === "delegate");
    return NextResponse.json({ ok: true, delegations });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not update delegation" }, { status: 400 });
  }
}
