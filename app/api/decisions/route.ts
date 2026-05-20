import { NextResponse } from "next/server";
import {
  listDecisions,
  createDecision,
  bulkImport,
} from "@/lib/decisions/store";
import type { Decision } from "@/lib/types/decision";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  const username = await getSessionUser();
  if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  const decisions = await listDecisions(username);
  return NextResponse.json({ decisions });
}

export async function POST(req: Request) {
  try {
    const username = await getSessionUser();
    if (!username) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    const body = await req.json();

    // Bulk import path (legacy data migration from localStorage)
    if (Array.isArray(body?.import)) {
      const added = await bulkImport(username, body.import as Decision[]);
      return NextResponse.json({ imported: added }, { status: 201 });
    }

    const {
      text,
      title,
      summary,
      rationale,
      alternatives,
      consequences,
      decidedBy,
      decidedById,
      stakeholders,
      date,
      context,
      source,
      confidence,
      tags,
    } = body as Partial<Decision>;

    if (!text || !text.trim()) {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }
    if (!decidedBy || !decidedBy.trim()) {
      return NextResponse.json({ error: "decidedBy is required" }, { status: 400 });
    }

    const decision = await createDecision(username, {
      text,
      title,
      summary,
      rationale,
      alternatives,
      consequences,
      decidedBy,
      decidedById,
      stakeholders,
      date,
      context,
      source,
      confidence,
      tags,
    });
    return NextResponse.json({ decision }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Operation failed" },
      { status: 500 }
    );
  }
}
