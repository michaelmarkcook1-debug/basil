import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getLearning, clearSourcePreference, clearCategoryEvents } from "@/lib/learning/store";
import { computeCategoryPriors } from "@/lib/learning/priors";

/**
 * GET  /api/learning/profile → { preferences, priors }
 *   The "What Basil has learned" surface: muted/demoted sources + category priors.
 * POST /api/learning/profile { op, sourceKey?, taskClass? }
 *   op "unmute" → clear a source preference; "reset-category" → relearn a class.
 */

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  try {
    const learning = await getLearning(username);
    const priors = Object.values(computeCategoryPriors(learning))
      .filter((p) => p.total >= 1)
      .sort((a, b) => b.total - a.total);
    return NextResponse.json({ preferences: learning.preferences ?? [], priors });
  } catch (err) {
    console.error("[learning/profile GET]", err);
    return NextResponse.json({ error: "Failed to load learning profile." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });

  let body: { op?: string; sourceKey?: string; taskClass?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    if (body.op === "unmute" && body.sourceKey) {
      await clearSourcePreference(username, body.sourceKey);
    } else if (body.op === "reset-category" && body.taskClass) {
      await clearCategoryEvents(username, body.taskClass);
    } else {
      return NextResponse.json({ error: "op + target required" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[learning/profile POST]", err);
    return NextResponse.json({ error: "Failed to update learning profile." }, { status: 500 });
  }
}
